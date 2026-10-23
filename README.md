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
