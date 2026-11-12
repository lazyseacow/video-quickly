// Windows' Job Object owns the runtime process tree even if Electron is killed.
// Only the Electron main process holds this non-inheritable job handle.
export async function windowsJobContainer() {
  if (process.platform !== 'win32') return undefined;
  const { default: koffi } = await import('koffi');
  return createWindowsJobContainer(koffi);
}

export function jobLimitLayout(koffi) {
  const basic = koffi.struct({
    PerProcessUserTimeLimit: 'int64_t', PerJobUserTimeLimit: 'int64_t', LimitFlags: 'uint32_t',
    MinimumWorkingSetSize: 'size_t', MaximumWorkingSetSize: 'size_t', ActiveProcessLimit: 'uint32_t',
    Affinity: 'uintptr_t', PriorityClass: 'uint32_t', SchedulingClass: 'uint32_t',
  });
  const counters = koffi.struct({
    ReadOperationCount: 'uint64_t', WriteOperationCount: 'uint64_t', OtherOperationCount: 'uint64_t',
    ReadTransferCount: 'uint64_t', WriteTransferCount: 'uint64_t', OtherTransferCount: 'uint64_t',
  });
  const extended = koffi.struct({
    BasicLimitInformation: basic, IoInfo: counters, ProcessMemoryLimit: 'size_t', JobMemoryLimit: 'size_t',
    PeakProcessMemoryUsed: 'size_t', PeakJobMemoryUsed: 'size_t',
  });
  return { bytes: koffi.sizeof(extended), flagOffset: koffi.offsetof(extended, 'BasicLimitInformation') + koffi.offsetof(basic, 'LimitFlags') };
}

export function createWindowsJobContainer(koffi) {
  const kernel = koffi.load('kernel32.dll');
  const createJob = kernel.func('void * __stdcall CreateJobObjectW(void *attributes, void *name)');
  const setInformation = kernel.func('int __stdcall SetInformationJobObject(void *job, int informationClass, void *information, uint32_t length)');
  const openProcess = kernel.func('void * __stdcall OpenProcess(uint32_t access, int inheritHandle, uint32_t processId)');
  const assignProcess = kernel.func('int __stdcall AssignProcessToJobObject(void *job, void *process)');
  const closeHandle = kernel.func('int __stdcall CloseHandle(void *handle)');
  const lastError = kernel.func('uint32_t __stdcall GetLastError(void)');
  const layout = jobLimitLayout(koffi);
  const failure = label => new Error(`${label}（Windows ${lastError()}）。`);
  return child => {
    if (!Number.isSafeInteger(child.pid) || child.pid <= 0) throw new Error('本地执行组件没有有效的进程编号。');
    const job = createJob(null, null);
    if (!job) throw failure('无法创建本地任务进程组');
    let open = true;
    const close = () => {
      if (!open) return;
      if (!closeHandle(job)) throw failure('无法关闭本地任务进程组');
      open = false;
    };
    try {
      const information = Buffer.alloc(layout.bytes);
      information.writeUInt32LE(0x00002000, layout.flagOffset); // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
      if (!setInformation(job, 9, information, information.length)) throw failure('无法设置本地任务退出规则');
      const process = openProcess(0x0100 | 0x0001, 0, child.pid); // PROCESS_SET_QUOTA | PROCESS_TERMINATE
      if (!process) throw failure('无法打开本地执行组件进程');
      let assignmentError;
      try { if (!assignProcess(job, process)) assignmentError = failure('无法将本地执行组件加入任务进程组'); }
      finally { closeHandle(process); }
      if (assignmentError) throw assignmentError;
      return { close };
    } catch (error) {
      close();
      throw error;
    }
  };
}
