# dirft

丝滑在Nodejs上使用Typescript开发，支持触发重启，实时转译和前后端全栈。

```ts
import { defineConfig } from 'vite'
import dirft from 'dirft'

export default defineConfig({
  plugins: [dirft({
    external: ['electron', 'ws', 'express'],
    restart: true,
    lazy: true,
  })],
  build: {
    target: 'node22',
    lib: { entry: 'src/main.ts', formats: ['es'] },
  },
})
```

转译、别名和插件复用 Vite，缓存统一放在 Vite `cacheDir`。静态依赖并发预热，动态导入按需加载；重启复用有效模块代码和 V8 编译缓存，每次仍启动全新 Node 进程。
