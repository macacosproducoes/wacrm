import { describe, it, expect } from 'vitest';
import { BulkImportModal } from './bulk-import-modal';

describe('BulkImportModal', () => {
  it('exporta o componente BulkImportModal corretamente', () => {
    expect(BulkImportModal).toBeDefined();
    expect(typeof BulkImportModal).toBe('function');
  });
});
