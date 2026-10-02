// tests/lib/stub.mjs — 宿主侧桩（v2 App 入口上下文 / 路由 app 与 ctx）。
//
// 形状照 SDK：createAppSdk 需要 dataDir(string) + bus.request(fn)，且为每个
// context 域调 bindDomain；注册类方法必须回执 { ready: Promise }，否则 SDK 抛
// APP_SDK_HOST_UNSUPPORTED。路由侧只需要 app.get / app.post 记录路径与处理器。

/**
 * 记录 get/post 的桩 app。
 * @returns {{ table: Array<{method:string,path:string,handler:Function}>, get: Function, post: Function }}
 */
export function makeStubApp() {
  const table = [];
  const record = (method) => (path, handler) => {
    table.push({ method, path, handler });
    return undefined;
  };
  return { table, get: record("GET"), post: record("POST") };
}

/** 桩 app 上取某方法的处理器；没有则抛错（用例里用 findRoute 断言存在性）。 */
export function findRoute(app, method, path) {
  return app.table.find((route) => route.method === method && route.path === path) || null;
}

/**
 * v2 App 入口上下文桩。tools.register 返回 { ready: Promise } 回执。
 * @returns {{ sdkContext: object, registered: object[], configWrites: Array<[string, unknown]> }}
 */
export function makeEntryContext({ dataDir, registered = [], configWrites = [] } = {}) {
  const sdkContext = {
    dataDir: String(dataDir),
    bus: { request: async () => ({}) },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    config: {
      getAll: async () => ({}),
      get: async () => undefined,
      set: async (key, value) => {
        configWrites.push([key, value]);
      },
    },
    tools: {
      register: (definition) => {
        registered.push(definition);
        return { ready: Promise.resolve() };
      },
    },
    hooks: {},
    models: {},
    media: {},
    providers: {},
    storage: { global: {}, agent: () => ({}) },
  };
  return { sdkContext, registered, configWrites };
}

/**
 * 路由 ctx 桩：dataDir + resources.read/write/stat + 记录写入的 config。
 * @returns {{ ctx: object, store: object, setCalls: Array<[string, unknown]> }}
 */
export function makeRoutesContext({ dataDir, store = {}, setCalls = [] } = {}) {
  const ctx = {
    dataDir: String(dataDir),
    resources: {
      read: async () => ({ content: "" }),
      write: async () => {},
      stat: async () => ({}),
    },
    config: {
      getAll: async () => ({ ...store }),
      get: async (key) => store[key],
      set: async (key, value) => {
        store[key] = value;
        setCalls.push([key, value]);
      },
    },
  };
  return { ctx, store, setCalls };
}

/** 造一个路由处理器用的请求上下文 c（c.req.json / c.req.query / c.json）。 */
export function fakeRequest({ body, query = {} } = {}) {
  return {
    req: {
      json: async () => body,
      query: (name) => (name === undefined ? { ...query } : query[name]),
    },
    json: (payload) => payload,
  };
}
