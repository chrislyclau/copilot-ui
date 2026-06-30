import { vi } from 'vitest';

vi.mock('../services/sessionGarbageCollector', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/sessionGarbageCollector')>();
  return {
    ...actual,
    startSessionGarbageCollector: vi.fn().mockReturnValue(() => {}),
  };
});
