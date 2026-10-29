// Adapted from nestjs/observe@7500fba (MIT, Copyright (c) 2017-present Kamil Mysliwiec). Changes: see third_party/nestjs-observe/FORK_DELTA.instrumentation.md
import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import type { AsyncLocalStorage } from 'node:async_hooks';
import { CALLER_KEY, REGISTRY_KEY, ROOT_TOKEN_KEY } from '../../context/constants.js';
import type { RootToken } from '../../context/root-token.js';
import { ignoreFailure, runAndSettle } from '../../context/settle.js';
import type { TraceRegistry } from '../../context/vendor/trace-registry.js';

/**
 * Stand-in "class name" for instrumented standalone functions. Unlike methods, they have no enclosing class to borrow a name
 * from, so every span they emit is grouped under this label.
 */
const STANDALONE_FUNCTION_LABEL = 'Function';

/** Class name for an instance that has no constructor function. */
const FALLBACK_CLASS_NAME = 'Object';

type AnyFunction = (...args: any[]) => any;
type Store = Map<string, unknown>;

/**
 * Whether an instance is a framework provider that is never instrumented, whatever `skipInstrumentation` says (Nest's
 * `Reflector`, asked several times per request). Matched by shape as well as by class: an application with a second copy of
 * `@nestjs/core` has a second `Reflector` class that `instanceof` alone would miss.
 */
function isFrameworkNoise(instance: object): boolean {
  if (instance instanceof Reflector) {
    return true;
  }
  const candidate = instance as {
    constructor?: { name?: unknown };
    getAllAndOverride?: unknown;
  };
  return candidate.constructor?.name === 'Reflector' && typeof candidate.getAllAndOverride === 'function';
}

interface TracedCallSpec {
  /** Name of the class owning the instrumented method, or `STANDALONE_FUNCTION_LABEL` for standalone functions. */
  className: string;
  methodName: string;
  spanId: string;

  /**
   * Re-entrancy guard. While a call is being traced, nested calls to the very same callable run untraced so that recursion
   * does not blow up the trace tree.
   */
  isActive: () => boolean;
  setActive: (active: boolean) => void;

  /** Invokes the original callable, participating in the trace. */
  call: (thisArg: unknown, args: unknown[]) => unknown;

  /** Invokes the original callable, bypassing instrumentation entirely. */
  callUntraced: (thisArg: unknown, args: unknown[]) => unknown;
}

export interface InstanceDecoratorDeps {
  als: AsyncLocalStorage<Store>;
  /** Resolved at call time so a replaced runtime (tests) or a late-configured one is picked up. */
  getRegistry: () => TraceRegistry;
  /**
   * Whether to skip instrumentation for a given instance (true = skip). Called for every DI instance and standalone
   * function; the instrument wraps it so a throwing predicate counts as true.
   */
  skipInstrumentation: (instance: unknown) => boolean;
}

interface StartedStep {
  registry: TraceRegistry;
  requestId: string;
  stepId: string;
  childStore: Store;
}

export function createInstanceDecorator(deps: InstanceDecoratorDeps) {
  const { als, skipInstrumentation } = deps;

  /**
   * Builds the tracing wrapper shared by methods and standalone functions.
   *
   * Every function this creates is named `<className>.<methodName>`, so the frames instrumentation contributes to a stack
   * trace read like the call the user actually made instead of `Proxy.proxyFn`.
   */
  const createTracedWrapper = (spec: TracedCallSpec) => {
    const { className, methodName, spanId } = spec;
    const frameName = `${className}.${methodName}`;

    // Pulled out of `spec` so they are invoked as plain functions: calling them as `spec.call(...)` would make `spec` the
    // frame's receiver and print "Object.<name>".
    const call = spec.call;
    const callUntraced = spec.callUntraced;

    // Opens the span. Every failure here (registry throws, store copy throws) leaves the call untraced: M7 fail-open.
    const startStep = (store: Store | undefined): StartedStep | undefined => {
      try {
        const requestId = store?.get(REGISTRY_KEY) as string | undefined;
        if (!store || !requestId) {
          return undefined;
        }
        // L-a: a closed token (root settled, force-closed, pluck window, stale store) means no new spans.
        const token = store.get(ROOT_TOKEN_KEY) as RootToken | undefined;
        if (token && token.open === false) {
          return undefined;
        }
        const registry = deps.getRegistry();
        const callerId = store.get(CALLER_KEY) as string | undefined;
        const stepId = registry.internalStartTraceStep(requestId, className, methodName, callerId);
        // No step means the registry holds no (open) trace for this id, or a budget refused the span.
        if (stepId === undefined) {
          return undefined;
        }
        let childStore: Store;
        try {
          childStore = new Map(store);
          childStore.set(CALLER_KEY, stepId);
        } catch {
          ignoreFailure(() => registry.internalEndTraceStep(requestId, spanId, className, methodName, stepId));
          return undefined;
        }
        return { registry, requestId, stepId, childStore };
      } catch {
        return undefined;
      }
    };

    // A function expression, not an arrow: the wrapper has to forward whatever `this` the caller invoked it with. Nested
    // arrows below inherit it.
    return named(frameName, function (this: unknown, ...args: unknown[]) {
      // Already tracing this callable, invoke it as-is
      if (spec.isActive()) {
        return callUntraced(this, args);
      }

      const started = startStep(als.getStore());
      if (started === undefined) {
        return callUntraced(this, args);
      }
      // After a successful start, so a failed start never leaves the flag stuck.
      spec.setActive(true);

      const { registry, requestId, stepId, childStore } = started;
      const onReturnValue = () => {
        registry.internalEndTraceStep(requestId, spanId, className, methodName, stepId);
      };
      const recordError = (err: unknown) => {
        // Before the registry records the step: the registry copies `err.stack` into the span payload, so relabelling
        // afterwards would leave that copy carrying this frame's `Proxy.`.
        relabelProxyFrame(err, className, methodName);
        registry.internalEndTraceStep(requestId, spanId, className, methodName, stepId, err, true);
      };
      return als.run(
        childStore,
        named(frameName, () => {
          try {
            // Same settle routine as roots and joined spans: value / throw identity, plain promise chained, other
            // promise watched on a side branch. Registry failures are swallowed inside.
            return runAndSettle(named(frameName, () => call(this, args)), onReturnValue, recordError);
          } finally {
            spec.setActive(false);
          }
        }),
      );
    });
  };

  const instrumentFunction = (fn: AnyFunction) => {
    // Classes are functions too, but calling one is a construction, not the kind of call this decorator traces.
    if (isConstructor(fn) || skipInstrumentation(fn)) {
      return fn;
    }

    const methodName = fn.name || 'anonymous';
    const className = STANDALONE_FUNCTION_LABEL;
    const frameName = `${className}.${methodName}`;

    // A standalone function has no owner object to hang per-instance state off, so the re-entrancy flag lives in this closure.
    let active = false;

    const invoke = named(frameName, (thisArg: unknown, args: unknown[]) => Reflect.apply(fn, thisArg, args));
    const tracedFn = createTracedWrapper({
      className,
      methodName,
      spanId: `${className}#${methodName}`,
      isActive: () => active,
      setActive: (value) => (active = value),
      call: invoke,
      callUntraced: invoke,
    });

    // Proxying the function keeps everything else about it intact: `name`, `length`, `prototype`, static properties,
    // `instanceof` and reflect-metadata lookups. Only `apply` is trapped, so `new fn()` still constructs the original.
    return new Proxy(fn, {
      apply: named(frameName, (_target, thisArg, args) => Reflect.apply(tracedFn, thisArg, args)),
    });
  };

  const instrumentObject = (instance: object) => {
    if (skipInstrumentation(instance)) {
      return instance;
    }

    // Native private members (`this.#x`) are branded to the instance itself, and no proxy trap can satisfy that check: a
    // method invoked with the proxy as its receiver throws. Such classes get the raw instance as receiver instead - trading
    // away nested `this.other()` spans for methods that run at all.
    //
    // Built-ins backed by internal slots (`Map`, `Set`, `Date`, ...) hit the same wall (nestjs/nest#17569).
    let hasPrivateMembers: boolean;
    let slotBacked: boolean;
    let bareBuiltIn: boolean;
    try {
      // Inspected inside the guard: reading a provider's constructor can run a trap that throws.
      if (isFrameworkNoise(instance)) {
        return instance;
      }
      hasPrivateMembers = usesNativePrivateMembers(instance);
      slotBacked = isSlotBackedBuiltIn(instance);
      bareBuiltIn = slotBacked && isNativeFunction(instance.constructor);
    } catch {
      // An instance that cannot be inspected cannot be instrumented; hand it back untouched.
      return instance;
    }

    // A bare built-in registered as a provider (`useValue: new Map()`) has no user code to trace.
    if (bareBuiltIn) {
      return instance;
    }

    // Slot-backed subclasses share the private-member trade-off: methods run against the raw instance.
    const requiresRawReceiver = hasPrivateMembers || slotBacked;

    const methodRefsCache = new WeakMap<object, Function>();
    const currentlyTracing = new WeakMap<object, Set<string>>();
    return new Proxy(instance, {
      get: (target, prop, receiver) => {
        // Read exactly once, outside the guard: a throwing getter fails as it would without Tracelet, and a plain getter
        // runs once (R-2).
        const attributeValue = Reflect.get(target, prop);
        // M7: any failure in the wrapper machinery returns the plain property value already read.
        try {
          const isFunction = typeof attributeValue === 'function' && prop !== 'constructor';

          const shouldProxy =
            isFunction &&
            // A constructor held in a field is invoked with `new` and read for statics; the traced wrapper supports neither.
            !isConstructor(attributeValue) &&
            // A callable *object* (a Mongoose model, an Axios instance) is a field, not a method.
            !isCallableObject(attributeValue);
          if (!shouldProxy) {
            return attributeValue;
          }

          const className = classNameOf(target);
          const methodName = String(prop);
          const frameName = `${className}.${methodName}`;

          // When "originalMethod" is already proxied, return the cached version
          if (methodRefsCache.has(attributeValue)) {
            return methodRefsCache.get(attributeValue);
          }

          // For a private-member class, `Reflect.get` with the proxy as receiver would already throw on an accessor that
          // touches `this.#x`, so the value fetched against the target above is reused instead.
          const originalMethod = requiresRawReceiver ? attributeValue : Reflect.get(target, prop, receiver);
          const tracedReceiver = requiresRawReceiver ? target : receiver;
          const proxyFn = createTracedWrapper({
            className,
            methodName,
            spanId: generateSpanId(target, methodName),
            isActive: () => currentlyTracing.get(target)?.has(methodName) ?? false,
            setActive: (active) => {
              if (!currentlyTracing.has(target)) {
                currentlyTracing.set(target, new Set());
              }
              const activeMethods = currentlyTracing.get(target)!;
              if (active) {
                activeMethods.add(methodName);
              } else {
                activeMethods.delete(methodName);
              }
            },
            // Traced calls run against the proxy so that a method calling into itself (`this.other()`) is instrumented as a
            // nested step - except for private-member classes, whose brand checks only the raw instance satisfies.
            call: named(frameName, (_thisArg, args) => originalMethod.apply(tracedReceiver, args)),
            callUntraced: named(frameName, (_thisArg, args) => originalMethod.apply(target, args)),
          });

          // V8 hard-codes the type name of a stack frame to "Proxy" whenever the frame's receiver is a proxy. The wrapper
          // never reads `this`, so handing it out with the receiver detached costs nothing and makes V8 print the
          // "<Class>.<method>" name above on its own.
          const boundFn = proxyFn.bind(undefined);

          // `bind` renames the function to "bound <name>" and drops metadata; restore both so the wrapper stays
          // indistinguishable from the original to anything reflecting over it (DI, decorators, arity checks).
          Object.defineProperty(boundFn, 'name', { value: originalMethod.name, configurable: true });
          Object.defineProperty(boundFn, 'length', { value: originalMethod.length, configurable: true });
          const metadataKeys = Reflect.getMetadataKeys(originalMethod);
          for (const key of metadataKeys) {
            const metadata = Reflect.getMetadata(key, originalMethod);
            Reflect.defineMetadata(key, metadata, boundFn);
          }

          methodRefsCache.set(attributeValue, boundFn);
          return boundFn;
        } catch {
          return attributeValue;
        }
      },
    });
  };

  return (instance: unknown) => {
    if (typeof instance === 'function') {
      return instrumentFunction(instance as AnyFunction);
    }
    if (typeof instance === 'object' && instance) {
      return instrumentObject(instance);
    }
    return instance;
  };
}

/**
 * Renames a function so that V8 prints `name` for the stack frames it appears in. The `name` property is what the stack
 * serializer reads, so redefining it is enough - the function keeps its identity and behavior.
 */
function named<T extends AnyFunction>(name: string, fn: T): T {
  Object.defineProperty(fn, 'name', { value: name, configurable: true });
  return fn;
}

/**
 * Rewrites the `Proxy.<method>` frame an instrumented call leaves behind into `<Class>.<method>`. Only the topmost match is
 * rewritten. Observable change vs an uninstrumented run: same error reference, different `stack` text (best effort).
 */
function relabelProxyFrame(err: unknown, className: string, methodName: string): void {
  if (!(err instanceof Error) || typeof err.stack !== 'string') {
    return;
  }
  // `async` prefixes the type name on frames resumed from an await.
  const frame = new RegExp(`(\\n\\s*at (?:async )?)Proxy\\.${escapeRegExp(methodName)}\\b`);
  if (!frame.test(err.stack)) {
    return;
  }
  try {
    err.stack = err.stack.replace(frame, `$1${className}.${methodName}`);
  } catch {
    // Some errors ship a read-only `stack`; the label is cosmetic.
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether a function is meant to be invoked with `new`: a `class`, or a constructor that predates the syntax - told apart by a
 * `prototype` carrying members of its own.
 */
function isConstructor(value: AnyFunction): boolean {
  if (/^\s*class\s+/.test(Function.prototype.toString.call(value))) {
    return true;
  }
  const prototype: unknown = value.prototype;
  return (
    typeof prototype === 'object' &&
    prototype !== null &&
    Reflect.ownKeys(prototype).some((key) => key !== 'constructor')
  );
}

/** The prototypes every ordinary function - plain, async, generator, async generator, arrow, bound - hangs off. */
const INTRINSIC_FUNCTION_PROTOTYPES = new Set<object | null>([
  Function.prototype,
  Object.getPrototypeOf(async function () {}),
  Object.getPrototypeOf(function* () {}),
  Object.getPrototypeOf(async function* () {}),
]);

/**
 * Whether a function is really an object with a call signature (a Mongoose model with its statics) rather than a method.
 * Two tells, either sufficient: a non-intrinsic prototype, or own enumerable properties.
 */
function isCallableObject(fn: AnyFunction): boolean {
  return !INTRINSIC_FUNCTION_PROTOTYPES.has(Object.getPrototypeOf(fn)) || Object.keys(fn).length > 0;
}

/**
 * Prototypes of the built-ins whose methods read internal slots off their receiver; such methods invoked with the
 * instrumentation proxy as receiver throw "called on incompatible receiver". `Array` is deliberately absent.
 */
const SLOT_BACKED_PROTOTYPES = new Set<object>([
  Map.prototype,
  Set.prototype,
  WeakMap.prototype,
  WeakSet.prototype,
  Date.prototype,
  RegExp.prototype,
  Promise.prototype,
  ArrayBuffer.prototype,
  ...(typeof SharedArrayBuffer === 'undefined' ? [] : [SharedArrayBuffer.prototype]),
  DataView.prototype,
  WeakRef.prototype,
  FinalizationRegistry.prototype,
  Object.getPrototypeOf(Uint8Array.prototype) as object,
]);

function isSlotBackedBuiltIn(instance: object): boolean {
  let proto: object | null = Object.getPrototypeOf(instance);
  while (proto) {
    if (SLOT_BACKED_PROTOTYPES.has(proto)) {
      return true;
    }
    proto = Object.getPrototypeOf(proto);
  }
  return false;
}

/** Whether a constructor is engine- or platform-provided rather than user code. */
function isNativeFunction(fn: unknown): boolean {
  if (typeof fn !== 'function') {
    return true;
  }
  try {
    return /\{\s*\[native code\]\s*\}$/.test(Function.prototype.toString.call(fn));
  } catch {
    return true;
  }
}

const privateMemberCache = new WeakMap<Function, boolean>();

/**
 * Whether any class in the instance's prototype chain declares native private members (`#field`, `#method()`). A `#` inside a
 * string or comment can false-positive, which merely selects the raw-instance receiver.
 */
function usesNativePrivateMembers(instance: object): boolean {
  let proto: object | null = Object.getPrototypeOf(instance);
  while (proto && proto !== Object.prototype) {
    const ctor = proto.constructor;
    if (typeof ctor === 'function' && ctor !== Object) {
      let hasPrivate = privateMemberCache.get(ctor);
      if (hasPrivate === undefined) {
        hasPrivate = declaresPrivateMembers(ctor);
        privateMemberCache.set(ctor, hasPrivate);
      }
      if (hasPrivate) {
        return true;
      }
    }
    proto = Object.getPrototypeOf(proto);
  }
  return false;
}

function declaresPrivateMembers(ctor: Function): boolean {
  try {
    // `#` starting a private name is never preceded by an identifier character.
    return /(^|[^\w$])#[\w$]/.test(Function.prototype.toString.call(ctor));
  } catch {
    return false;
  }
}

/** The class name that labels an instance's spans; null-prototype objects and module namespaces fall back to `Object`. */
function classNameOf(instance: object): string {
  const ctor: unknown = Reflect.get(instance, 'constructor');
  return typeof ctor === 'function' ? ctor.name : FALLBACK_CLASS_NAME;
}

function generateSpanId(instance: object, methodKey: string): string {
  return `${classNameOf(instance)}#${methodKey}`;
}
