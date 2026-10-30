import { MongoClient } from 'mongodb';
import type { TraceletModuleOptions } from '../contracts/observe-contracts';

/** Dedicated Tracelet pool. The URI and underlying driver failures are never logged here. */
export function createMongoClient(options: TraceletModuleOptions['storage']): MongoClient {
  const maxPoolSize = options.maxPoolSize ?? 5;
  const timeout = options.serverSelectionTimeoutMS ?? 5000;
  if (!options.uri || !Number.isSafeInteger(maxPoolSize) || maxPoolSize < 1 || maxPoolSize > 5 || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30000) throw new Error('invalid storage configuration');
  return new MongoClient(options.uri, { appName: 'tracelet', maxPoolSize, minPoolSize: 0, serverSelectionTimeoutMS: timeout, connectTimeoutMS: timeout, socketTimeoutMS: 5000, retryWrites: true });
}
