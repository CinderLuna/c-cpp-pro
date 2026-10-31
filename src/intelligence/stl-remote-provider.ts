import * as fs from 'fs';
import * as path from 'path';
import type { StlDocEntry } from './stl-knowledge-base';

/**
 * Built-in offline fallback documentation records for system and POSIX/Win32 APIs.
 * Ensures instant lookups even without internet access.
 */
const SYSTEM_OFFLINE_DOCS: Record<string, StlDocEntry> = {
  // --- Win32 System APIs (<windows.h>) ---
  'CreateFileW': {
    symbol: 'CreateFileW',
    canonicalSignature:
      'HANDLE CreateFileW(\n  LPCWSTR               lpFileName,\n  DWORD                 dwDesiredAccess,\n  DWORD                 dwShareMode,\n  LPSECURITY_ATTRIBUTES lpSecurityAttributes,\n  DWORD                 dwCreationDisposition,\n  DWORD                 dwFlagsAndAttributes,\n  HANDLE                hTemplateFile\n);',
    summary:
      'Creates or opens a file, directory, physical disk, volume, console buffer, tape, or communication resource on Windows. Returns a kernel object handle.',
    header: '<windows.h>',
    standard: 'Win32 API',
    parameters: {
      lpFileName: 'The path of the file or device to be created or opened.',
      dwDesiredAccess: 'The requested access to the file or device (e.g. `GENERIC_READ | GENERIC_WRITE`).',
      dwShareMode: 'The requested sharing mode (e.g. `FILE_SHARE_READ`, `0` for exclusive).',
      lpSecurityAttributes: 'Security descriptor pointer and child inheritance flag.',
      dwCreationDisposition: 'Action to take on existing/non-existing file (`CREATE_ALWAYS`, `OPEN_EXISTING`, etc.).',
      dwFlagsAndAttributes: 'File attributes and flags (`FILE_ATTRIBUTE_NORMAL`, `FILE_FLAG_OVERLAPPED`).',
      hTemplateFile: 'Valid handle to a template file with `GENERIC_READ` access rights, or `NULL`.'
    },
    returns: 'An open handle to the specified file or device. If the function fails, the return value is `INVALID_HANDLE_VALUE`. Call `GetLastError()` for error code.',
    docUrl: 'https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew',
    complexity: { time: 'NTFS/FAT filesystem lookup syscall' },
    example:
      'HANDLE hFile = CreateFileW(\n    L"C:\\\\data.bin",\n    GENERIC_READ,\n    FILE_SHARE_READ,\n    NULL,\n    OPEN_EXISTING,\n    FILE_ATTRIBUTE_NORMAL,\n    NULL\n);\nif (hFile == INVALID_HANDLE_VALUE) {\n    DWORD err = GetLastError();\n}',
    seeAlso: ['CloseHandle', 'ReadFile', 'WriteFile', 'GetLastError']
  },
  'CloseHandle': {
    symbol: 'CloseHandle',
    canonicalSignature: 'BOOL CloseHandle(HANDLE hObject);',
    summary:
      'Closes an open object handle (file, process, thread, event, mutex, pipe). Decrements handle count and frees system resources when count reaches zero.',
    header: '<windows.h>',
    standard: 'Win32 API',
    parameters: {
      hObject: 'A valid handle to an open object.'
    },
    returns: 'If the function succeeds, return value is nonzero (`TRUE`). If fails, return value is zero (`FALSE`). Call `GetLastError()` for details.',
    docUrl: 'https://learn.microsoft.com/en-us/windows/win32/api/handleapi/nf-handleapi-closehandle',
    complexity: { time: 'O(1) kernel handle table update' },
    example:
      'if (hFile != INVALID_HANDLE_VALUE) {\n    CloseHandle(hFile);\n    hFile = INVALID_HANDLE_VALUE;\n}',
    seeAlso: ['CreateFileW', 'GetLastError']
  },
  'GetLastError': {
    symbol: 'GetLastError',
    canonicalSignature: 'DWORD GetLastError(void);',
    summary:
      'Retrieves the calling thread\'s last-error code value. Most Win32 functions set this value when they fail. Error codes are 32-bit unsigned integers.',
    header: '<windows.h>',
    standard: 'Win32 API',
    parameters: {},
    returns: 'The calling thread\'s last-error code.',
    docUrl: 'https://learn.microsoft.com/en-us/windows/win32/api/errhandlingapi/nf-errhandlingapi-getlasterror',
    complexity: { time: 'O(1) read from Thread Environment Block (TEB)' },
    example:
      'DWORD errorCode = GetLastError();\nwprintf(L"Operation failed with Win32 error code: %lu\\n", errorCode);',
    seeAlso: ['FormatMessageW', 'SetLastError']
  },
  'Sleep': {
    symbol: 'Sleep',
    canonicalSignature: 'void Sleep(DWORD dwMilliseconds);',
    summary:
      'Suspends the execution of the current thread until the time-out interval elapses. Yields remaining thread quantum to other ready threads.',
    header: '<windows.h>',
    standard: 'Win32 API',
    parameters: {
      dwMilliseconds: 'The time interval for which execution is to be suspended, in milliseconds. If `0`, yields timeslice.'
    },
    returns: '`void`',
    docUrl: 'https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-sleep',
    complexity: { time: 'Thread scheduler deschedule context switch' },
    example:
      'Sleep(100); // Sleep for 100 milliseconds',
    seeAlso: ['std::this_thread::sleep_for']
  },

  // --- POSIX System APIs (<unistd.h>, <pthread.h>) ---
  'fork': {
    symbol: 'fork',
    canonicalSignature: 'pid_t fork(void);',
    summary:
      'Creates a new process by duplicating the calling process. The child process is an exact copy with copy-on-write (COW) page tables.',
    header: '<unistd.h>',
    standard: 'POSIX.1-2001',
    parameters: {},
    returns: 'On success, child PID is returned to parent, and 0 is returned to child. On failure, -1 is returned to parent, and errno is set.',
    docUrl: 'https://man7.org/linux/man-pages/man2/fork.2.html',
    complexity: { time: 'Page table copy-on-write allocation O(VM pages)' },
    example:
      'pid_t pid = fork();\nif (pid == 0) {\n    // In child process\n    _exit(0);\n} else if (pid > 0) {\n    // In parent process\n    waitpid(pid, NULL, 0);\n}',
    seeAlso: ['execve', 'waitpid', 'pipe']
  },
  'pipe': {
    symbol: 'pipe',
    canonicalSignature: 'int pipe(int pipefd[2]);',
    summary:
      'Creates a unidirectional data channel that can be used for interprocess communication. `pipefd[0]` is read end, `pipefd[1]` is write end.',
    header: '<unistd.h>',
    standard: 'POSIX.1-2001',
    parameters: {
      pipefd: 'Array of two file descriptors: pipefd[0] is read end, pipefd[1] is write end.'
    },
    returns: 'On success, 0. On error, -1 is returned and errno is set.',
    docUrl: 'https://man7.org/linux/man-pages/man2/pipe.2.html',
    complexity: { time: 'Kernel buffer allocation' },
    example:
      'int fds[2];\nif (pipe(fds) == 0) {\n    write(fds[1], "hello", 5);\n    close(fds[1]);\n    close(fds[0]);\n}',
    seeAlso: ['fork', 'dup2', 'close']
  },
  'close': {
    symbol: 'close',
    canonicalSignature: 'int close(int fd);',
    summary:
      'Closes a file descriptor, so that it no longer refers to any file and may be reused.',
    header: '<unistd.h>',
    standard: 'POSIX.1-2001',
    parameters: {
      fd: 'File descriptor to close.'
    },
    returns: '0 on success; -1 on error with errno set.',
    docUrl: 'https://man7.org/linux/man-pages/man2/close.2.html',
    complexity: { time: 'O(1) file descriptor table entry clear' },
    example:
      'close(fd);',
    seeAlso: ['open', 'read', 'write']
  },
  'read': {
    symbol: 'read',
    canonicalSignature: 'ssize_t read(int fd, void *buf, size_t count);',
    summary:
      'Attempts to read up to count bytes from file descriptor fd into the buffer starting at buf.',
    header: '<unistd.h>',
    standard: 'POSIX.1-2001',
    parameters: {
      fd: 'File descriptor to read from.',
      buf: 'Destination buffer to receive read bytes.',
      count: 'Maximum number of bytes to read.'
    },
    returns: 'On success, the number of bytes read is returned (0 indicates end of file). On error, -1 is returned and errno is set.',
    docUrl: 'https://man7.org/linux/man-pages/man2/read.2.html',
    complexity: { time: 'OS filesystem read syscall' },
    example:
      'char buffer[256];\nssize_t bytesRead = read(fd, buffer, sizeof(buffer));',
    seeAlso: ['write', 'open', 'close']
  },
  'write': {
    symbol: 'write',
    canonicalSignature: 'ssize_t write(int fd, const void *buf, size_t count);',
    summary:
      'Writes up to count bytes from the buffer starting at buf to the file referred to by the file descriptor fd.',
    header: '<unistd.h>',
    standard: 'POSIX.1-2001',
    parameters: {
      fd: 'File descriptor to write to.',
      buf: 'Source buffer containing bytes to write.',
      count: 'Number of bytes to write.'
    },
    returns: 'On success, the number of bytes written is returned. On error, -1 is returned and errno is set.',
    docUrl: 'https://man7.org/linux/man-pages/man2/write.2.html',
    complexity: { time: 'OS filesystem write syscall' },
    example:
      'const char msg[] = "data\\n";\nwrite(fd, msg, sizeof(msg) - 1);',
    seeAlso: ['read', 'open', 'close']
  },
  'pthread_create': {
    symbol: 'pthread_create',
    canonicalSignature:
      'int pthread_create(pthread_t *thread, const pthread_attr_t *attr,\n                   void *(*start_routine) (void *), void *arg);',
    summary:
      'Starts a new thread in the calling process. The new thread starts execution by invoking `start_routine(arg)`.',
    header: '<pthread.h>',
    standard: 'POSIX.1-2001',
    parameters: {
      thread: 'Pointer to buffer where the pthread ID of the new thread is stored.',
      attr: 'Thread attributes pointer (or NULL for default).',
      start_routine: 'Function pointer to execute in thread.',
      arg: 'Sole argument passed to start_routine.'
    },
    returns: 'On success, returns 0. On error, returns an error number (e.g. EAGAIN).',
    docUrl: 'https://man7.org/linux/man-pages/man3/pthread_create.3.html',
    complexity: { time: 'Kernel thread clone syscall and stack allocation' },
    example:
      'pthread_t t;\npthread_create(&t, NULL, worker_fn, NULL);\npthread_join(t, NULL);',
    seeAlso: ['pthread_join', 'pthread_detach', 'std::thread']
  },
  'pthread_join': {
    symbol: 'pthread_join',
    canonicalSignature: 'int pthread_join(pthread_t thread, void **retval);',
    summary:
      'Waits for the thread specified by `thread` to terminate. If that thread has already terminated, then pthread_join() returns immediately.',
    header: '<pthread.h>',
    standard: 'POSIX.1-2001',
    parameters: {
      thread: 'The target thread ID to wait on.',
      retval: 'Pointer to location where exit status is copied (or NULL).'
    },
    returns: '0 on success; error number on failure.',
    docUrl: 'https://man7.org/linux/man-pages/man3/pthread_join.3.html',
    complexity: { time: 'Thread synchronization wait' },
    example:
      'void* res = NULL;\npthread_join(thread, &res);',
    seeAlso: ['pthread_create', 'pthread_exit']
  }
};

/**
 * Manages system-specific header documentation.
 * Resolves platform headers (<windows.h>, <unistd.h>, <pthread.h>) using:
 * 1. Fast in-memory cache
 * 2. Persistent local disk cache (${cacheDir}/${headerSlug}.json)
 * 3. Asynchronous remote GitHub / CDN fetcher with 1.5s timeout guard and graceful fallback
 */
export class StlRemoteProvider {
  private static instance: StlRemoteProvider | null = null;
  private memoryCache: Map<string, StlDocEntry> = new Map();
  private cacheDir: string | null = null;
  private remoteBaseUrl: string =
    'https://raw.githubusercontent.com/CinderLuna/C/C++ Pro-Docs/main/system-headers';

  private constructor() {
    // Populate offline fallback docs into memory
    for (const [key, entry] of Object.entries(SYSTEM_OFFLINE_DOCS)) {
      this.memoryCache.set(key, entry);
      const cleanKey = key.replace(/^::/, '');
      this.memoryCache.set(cleanKey, entry);
    }
  }

  public static getInstance(): StlRemoteProvider {
    if (!StlRemoteProvider.instance) {
      StlRemoteProvider.instance = new StlRemoteProvider();
    }
    return StlRemoteProvider.instance;
  }

  /**
   * Configures local disk cache path (e.g. extension globalStorageUri/stl_docs).
   */
  public setCacheDirectory(dirPath: string): void {
    this.cacheDir = dirPath;
    try {
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }
    } catch {
      // Ignore directory creation errors in constrained environments
    }
  }

  /**
   * Sets remote repository base URL.
   */
  public setRemoteBaseUrl(url: string): void {
    if (url) {
      this.remoteBaseUrl = url.replace(/\/$/, '');
    }
  }

  /**
   * Fast synchronous lookup against in-memory system doc cache.
   */
  public lookupSync(symbolKey: string): StlDocEntry | null {
    if (!symbolKey) return null;
    const clean = symbolKey.trim().replace(/^::/, '');
    if (this.memoryCache.has(clean)) {
      return this.memoryCache.get(clean) ?? null;
    }
    const bare = clean.split('::').pop() ?? '';
    if (this.memoryCache.has(bare)) {
      return this.memoryCache.get(bare) ?? null;
    }
    return null;
  }

  /**
   * Asynchronous lookup against in-memory cache, disk cache, and remote fetcher.
   */
  public async lookup(symbolKey: string): Promise<StlDocEntry | null> {
    const syncHit = this.lookupSync(symbolKey);
    if (syncHit) {
      return syncHit;
    }

    const clean = symbolKey.trim().replace(/^::/, '');
    const bare = clean.split('::').pop() ?? clean;

    // 1. Check disk cache if cache directory configured
    if (this.cacheDir) {
      const diskEntry = await this.readFromDiskCache(bare);
      if (diskEntry) {
        this.memoryCache.set(bare, diskEntry);
        this.memoryCache.set(clean, diskEntry);
        return diskEntry;
      }
    }

    // 2. Fetch from remote repository with 1.5s timeout
    const remoteEntry = await this.fetchRemote(bare);
    if (remoteEntry) {
      this.memoryCache.set(bare, remoteEntry);
      this.memoryCache.set(clean, remoteEntry);
      if (this.cacheDir) {
        await this.writeToDiskCache(bare, remoteEntry);
      }
      return remoteEntry;
    }

    return null;
  }

  /**
   * Retrieves all built-in offline documentation records matching a given header.
   */
  public getOfflineEntriesByHeader(headerName: string): StlDocEntry[] {
    let norm = headerName.trim().toLowerCase();
    if (!norm.startsWith('<')) norm = `<${norm}>`;

    const results: StlDocEntry[] = [];
    for (const entry of Object.values(SYSTEM_OFFLINE_DOCS)) {
      if (entry.header.trim().toLowerCase() === norm) {
        results.push(entry);
      }
    }
    return results;
  }

  private async readFromDiskCache(symbol: string): Promise<StlDocEntry | null> {
    if (!this.cacheDir) return null;
    try {
      const safeFilename = `${symbol.replace(/[^a-zA-Z0-9_]/g, '_')}.json`;
      const filePath = path.join(this.cacheDir, safeFilename);
      if (fs.existsSync(filePath)) {
        const content = await fs.promises.readFile(filePath, 'utf-8');
        const parsed = JSON.parse(content) as StlDocEntry;
        return parsed;
      }
    } catch {
      // Ignore disk read or parse failures
    }
    return null;
  }

  private async writeToDiskCache(symbol: string, entry: StlDocEntry): Promise<void> {
    if (!this.cacheDir) return;
    try {
      const safeFilename = `${symbol.replace(/[^a-zA-Z0-9_]/g, '_')}.json`;
      const filePath = path.join(this.cacheDir, safeFilename);
      await fs.promises.writeFile(filePath, JSON.stringify(entry, null, 2), 'utf-8');
    } catch {
      // Ignore cache write errors
    }
  }

  private async fetchRemote(symbol: string): Promise<StlDocEntry | null> {
    if (typeof fetch !== 'function') {
      return null;
    }

    const targetUrl = `${this.remoteBaseUrl}/${encodeURIComponent(symbol)}.json`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1500);

    try {
      const res = await fetch(targetUrl, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (!res.ok) {
        return null;
      }
      const data = (await res.json()) as StlDocEntry;
      if (data && data.symbol && data.canonicalSignature) {
        return data;
      }
    } catch {
      // Offline, aborted, or connection error - fail silently
    } finally {
      clearTimeout(timeoutId);
    }
    return null;
  }
}
