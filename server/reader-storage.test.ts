import { describe, expect, it } from 'vitest';
import { evaluateReaderStorage, READER_STORAGE_POLICY } from './reader-storage.js';

const MIB = 1_024 * 1_024;

function assessment(overrides: Partial<Parameters<typeof evaluateReaderStorage>[0]> = {}) {
  return evaluateReaderStorage({
    databasePath: '/data/chadashot.sqlite',
    pageSizeBytes: 4_096,
    pageCount: 250_000,
    freePageCount: 0,
    databaseFileBytes: 250_000 * 4_096,
    walBytes: 0,
    filesystemAvailableBytes: 600 * MIB,
    currentGenerationLogicalBytes: 100 * MIB,
    ...overrides,
  });
}

describe('reader storage guard', () => {
  it('counts reusable database pages toward staging but not WAL reserve', () => {
    const withoutReusablePages = assessment();
    const withReusablePages = assessment({ freePageCount: (400 * MIB) / 4_096 });

    expect(withoutReusablePages.canImport).toBe(false);
    expect(withReusablePages.canImport).toBe(true);
    expect(withReusablePages.additionalFilesystemBytes).toBe(112 * MIB);
    expect(withReusablePages.walReserveBytes).toBe(READER_STORAGE_POLICY.minimumWalReserveBytes);
  });

  it('still defers when reusable pages cover staging but filesystem WAL reserve is unsafe', () => {
    const result = assessment({
      freePageCount: (512 * MIB) / 4_096,
      filesystemAvailableBytes: 300 * MIB,
    });

    expect(result.additionalFilesystemBytes).toBe(0);
    expect(result.importRequiredFilesystemBytes).toBe(384 * MIB);
    expect(result.canImport).toBe(false);
    expect(result.canPrune).toBe(false);
  });

  it('uses a conservative floor for an initial import with no committed generation', () => {
    const result = assessment({
      pageCount: 10,
      databaseFileBytes: 10 * 4_096,
      currentGenerationLogicalBytes: 0,
      filesystemAvailableBytes: Number.MAX_SAFE_INTEGER,
    });

    expect(result.estimatedStagedGenerationBytes).toBe(READER_STORAGE_POLICY.minimumStagedGenerationBytes);
    expect(result.canImport).toBe(true);
  });
});
