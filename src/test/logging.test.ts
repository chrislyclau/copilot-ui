import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { writeLog, LogLevel, setLogLevels, lastRunLog, initLogFile } from '../orchestrator/sessionState';

const LOG_FILE = '/tmp/debug_log.txt';

describe('Logging System Tests', () => {
  beforeEach(() => {
    // Clear in-memory log
    lastRunLog.length = 0;
    // Reset log levels to default for tests
    setLogLevels(LogLevel.INFO, LogLevel.DEBUG);
    // Initialize log file
    initLogFile();
  });

  afterAll(() => {
    // Optional: cleanup log file if needed
    // try { fs.unlinkSync(LOG_FILE); } catch (e) {}
  });

  it('should write to file at DEBUG level even if console is at INFO', () => {
    setLogLevels(LogLevel.INFO, LogLevel.DEBUG);
    const testMsg = `Test Debug Message ${Date.now()}`;
    writeLog(testMsg, LogLevel.DEBUG);

    // Should NOT be in memory log (since INFO > DEBUG)
    const inMemory = lastRunLog.some(l => l.includes(testMsg));
    expect(inMemory).toBe(false);

    // Should BE in file
    const fileContent = fs.readFileSync(LOG_FILE, 'utf8');
    expect(fileContent).toContain(testMsg);
    expect(fileContent).toContain('[DEBUG]');
  });

  it('should write to memory and file at INFO level', () => {
    setLogLevels(LogLevel.INFO, LogLevel.DEBUG);
    const testMsg = `Test Info Message ${Date.now()}`;
    writeLog(testMsg, LogLevel.INFO);

    // Should BE in memory log
    const inMemory = lastRunLog.some(l => l.includes(testMsg));
    expect(inMemory).toBe(true);

    // Should BE in file
    const fileContent = fs.readFileSync(LOG_FILE, 'utf8');
    expect(fileContent).toContain(testMsg);
    expect(fileContent).toContain('[INFO]');
  });

  it('should cap in-memory logs at 500 lines', () => {
    setLogLevels(LogLevel.DEBUG, LogLevel.DEBUG);
    for (let i = 0; i < 600; i++) {
      writeLog(`Msg ${i}`, LogLevel.DEBUG);
    }
    expect(lastRunLog.length).toBe(500);
    // First message should have been shifted out
    expect(lastRunLog[0]).toContain('Msg 100');
  });

  it('should include level name in log lines', () => {
    writeLog('Warn msg', LogLevel.WARN);
    writeLog('Error msg', LogLevel.ERROR);
    
    const fileContent = fs.readFileSync(LOG_FILE, 'utf8');
    expect(fileContent).toContain('[WARN] Warn msg');
    expect(fileContent).toContain('[ERROR] Error msg');
  });
});
