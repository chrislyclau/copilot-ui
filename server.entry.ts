import { app, initLogFile } from './server';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import express from 'express';
import { initializeWorkspace } from './src/agentCore/workspace';
import { createTaskGitSandbox } from './src/orchestration/taskGitSandbox';

const PORT = parseInt(process.env.PORT || '3000', 10);

async function start() {
  // Install the app's TaskGitSandbox so the shared sandbox carries the
  // task/PBI branch operations the gate loop uses.
  await initializeWorkspace({ createSandbox: createTaskGitSandbox });
  // Vite preview or static file serving
  if (process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    initLogFile();
    console.log(`Server running on port ${PORT}`);
  });
}

start();
