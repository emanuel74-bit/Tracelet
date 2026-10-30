// Adapted from nestjs/observe@7500fba (MIT, Copyright (c) 2017-present Kamil Mysliwiec). Changes: see third_party/nestjs-observe/FORK_DELTA.instrumentation.md

export type KeyOf<T> = keyof T extends never ? string | symbol : keyof T;
