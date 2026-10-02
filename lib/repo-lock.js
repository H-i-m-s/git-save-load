// lib/repo-lock.js —— 同一仓库的写操作串行化（进程内按仓库分桶的 FIFO 互斥）
//
// 背景：应用后端是单线程 Node 进程。以前 git 调用都用 execFileSync，事件循环天然把
// 同一仓库上的操作排成队；把这些网络调用改成异步之后，这层隐式串行就没有了，两个写
// 操作（fetch / merge / push / …）可能同时进入同一个 .git，撞上 git 的 ref / index
// 锁文件，报出 "cannot lock ref"、"Unable to create ... .lock" 这类难懂的错误。
//
// 因此异步化必须配一把锁，但只锁「会改仓库」的操作：
//   加锁：fetch / pull / push / merge / overwrite，以及其它写操作（commit、stash …）
//   不加锁：status / log / diff / rev-parse / symbolic-ref 等只读命令
// 把只读命令也排到一次 120 s 的 fetch 后面，等于把「整个面板卡住」按比例缩小重演。
//
// 作用域：进程内共享同一份 Map（ESM 单例），同一进程里所有路由模块拿到的是同一把锁。
// 只在一个进程内有效；应用后端本来就是单进程，够用。

const chains = new Map(); // key: 规范化仓库路径 → 队尾 Promise

// Windows 路径大小写不敏感，正反斜杠等价，末尾分隔符可有可无；
// 归一成同一个 key，否则同一仓库会被当成两个桶，锁就形同虚设。
function lockKey(path) {
  const raw = String(path || "").trim();
  if (!raw) return "<none>";
  return raw.replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase();
}

/**
 * 在指定仓库上串行执行 fn：同一路径的多次调用按到达顺序排队，前一个结束（成功或
 * 失败都算）才轮到下一个。
 * @param {string} path 仓库路径
 * @param {() => any | Promise<any>} fn 要执行的操作（同步或异步都可以）
 * @returns {Promise<any>} fn 的返回值 / 抛出的错误
 */
export function withRepoLock(path, fn) {
  const key = lockKey(path);
  const prev = chains.get(key) || Promise.resolve();
  const run = prev.then(() => fn());
  // 队尾只用来排队，必须吞掉失败，否则一次失败会把后续等待者一起带崩
  const tail = run.then(() => {}, () => {});
  chains.set(key, tail);
  tail.then(() => {
    // 队列已空就清掉，避免 Map 随历史路径无限增长
    if (chains.get(key) === tail) chains.delete(key);
  });
  return run;
}

/** 仅用于测试/诊断：当前仍有排队的仓库桶数量。 */
export function repoLockSize() {
  return chains.size;
}
