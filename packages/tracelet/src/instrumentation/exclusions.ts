// Exclusion list idea from nestjs/observe@7500fba `observe.module.ts:356-406` (MIT, Copyright (c) 2017-present Kamil Mysliwiec).
import {
  ApplicationConfig,
  DiscoveryService,
  HttpAdapterHost,
  LazyModuleLoader,
  MetadataScanner,
  ModuleRef,
  ModulesContainer,
} from '@nestjs/core';
import { getRuntime } from '../context/runtime.js';
import { isTraceletInternal } from '../shared/brand.js';
import { traceletAls } from '../shared/als.js';

/**
 * Nest's own machinery stays unproxied: `ModulesContainer` extends `Map` (a Map method invoked with the proxy as receiver
 * throws), and the others are framework plumbing, not application code. `Reflector` is excluded inside the decorator.
 */
const NEST_INTERNALS: Array<abstract new (...args: never[]) => unknown> = [
  ModulesContainer,
  DiscoveryService,
  MetadataScanner,
  HttpAdapterHost,
  ApplicationConfig,
  ModuleRef,
  LazyModuleLoader,
];

/**
 * The skip predicate: true = leave the instance unproxied. The whole predicate is guarded; an instance that throws on
 * inspection (nestjs-cls proxy providers outside a CLS context) cannot be instrumented either way, so it is skipped.
 * A throwing user predicate counts as true.
 */
export function createSkipPredicate(user?: (instance: unknown) => boolean): (instance: unknown) => boolean {
  return (instance: unknown): boolean => {
    try {
      if (isTraceletInternal(instance)) {
        return true;
      }
      if (user !== undefined && user(instance)) {
        return true;
      }
      if (instance === traceletAls || instance === getRuntime().registry) {
        return true;
      }
      for (const ctor of NEST_INTERNALS) {
        if (instance instanceof ctor) {
          return true;
        }
      }
      return false;
    } catch {
      return true;
    }
  };
}
