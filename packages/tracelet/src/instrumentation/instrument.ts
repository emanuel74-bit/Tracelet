// Instrument shape from nestjs/observe@7500fba `observe.module.ts:408-431` (MIT, Copyright (c) 2017-present Kamil Mysliwiec).
import type { NestApplicationContextOptions } from '@nestjs/common/interfaces/nest-application-context-options.interface.js';
import type { TraceletInstrumentOptions } from '../contracts/index.js';
import { getRuntime } from '../context/runtime.js';
import { isRuntimeCompatible, traceletAls } from '../shared/als.js';
import { envDisabled, envEnabled, isDevOrTest } from '../shared/env.js';
import { createSkipPredicate } from './exclusions.js';
import { createInstanceDecorator } from './vendor/instance-decorator.js';

export type NestInstrument = NonNullable<NestApplicationContextOptions['instrument']>;

/** Enable decision, evaluated at each decoration: TRACELET_DISABLED=1 > options.enabled > TRACELET_ENABLED > dev/test default. */
function isEnabled(options: TraceletInstrumentOptions | undefined): boolean {
  if (envDisabled()) return false;
  if (options?.enabled !== undefined) return options.enabled;
  const fromEnv = envEnabled();
  if (fromEnv !== undefined) return fromEnv;
  return isDevOrTest();
}

/**
 * The object passed to `NestFactory.create/createMicroservice/createApplicationContext({ instrument })`.
 * When disabled it returns every instance untouched. The outer guard exists because Nest 11.1.4/11.1.6 call the decorator
 * without one (`injector.js:414,419`, `module.js:247`).
 */
export function createTraceletInstrument(options?: TraceletInstrumentOptions): NestInstrument {
  const skip = createSkipPredicate(options?.skipInstrumentation);
  let decorate: ((instance: unknown) => unknown) | undefined;

  return {
    instanceDecorator: (instance: unknown): unknown => {
      try {
        if (!isRuntimeCompatible() || !isEnabled(options)) {
          return instance;
        }
        decorate ??= createInstanceDecorator({
          als: traceletAls,
          getRegistry: () => getRuntime().registry,
          skipInstrumentation: skip,
        });
        const decorated = decorate(instance);
        if (decorated !== instance) {
          getRuntime().instrumentInstalled = true;
        }
        return decorated;
      } catch {
        return instance;
      }
    },
  };
}

/** `TraceletInstrument === createTraceletInstrument()`. */
export const TraceletInstrument: NestInstrument = createTraceletInstrument();
