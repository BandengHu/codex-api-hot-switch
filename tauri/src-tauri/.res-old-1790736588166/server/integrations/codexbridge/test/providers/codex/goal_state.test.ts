import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CodexGoalManager } from '../../../src/providers/codex/goal_state.js';

test('CodexGoalManager reads, writes, pauses, resumes, and clears the global goal file', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-goal-'));
  const filePath = path.join(root, 'codex-goal.txt');
  const manager = new CodexGoalManager({ filePath });

  const empty = await manager.readGoal();
  assert.equal(empty.exists, false);
  assert.equal(empty.goal, '');
  assert.equal(empty.paused, false);

  const saved = await manager.writeGoal('Keep CodexBridge stable.');
  assert.equal(saved.exists, true);
  assert.equal(saved.goal, 'Keep CodexBridge stable.');
  assert.equal(saved.paused, false);

  const reloaded = await manager.readGoal();
  assert.equal(reloaded.exists, true);
  assert.equal(reloaded.goal, 'Keep CodexBridge stable.');
  assert.equal(reloaded.paused, false);

  const paused = await manager.pauseGoal();
  assert.equal(paused.exists, true);
  assert.equal(paused.goal, 'Keep CodexBridge stable.');
  assert.equal(paused.paused, true);

  const resumed = await manager.resumeGoal();
  assert.equal(resumed.exists, true);
  assert.equal(resumed.goal, 'Keep CodexBridge stable.');
  assert.equal(resumed.paused, false);

  const cleared = await manager.clearGoal();
  assert.equal(cleared.exists, false);
  assert.equal(cleared.goal, '');
  assert.equal(cleared.paused, false);
});

test('CodexGoalManager tolerates legacy plain-text goal files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-goal-legacy-'));
  const filePath = path.join(root, 'codex-goal.txt');
  await fs.writeFile(filePath, 'Legacy goal text\n', 'utf8');
  const manager = new CodexGoalManager({ filePath });

  const snapshot = await manager.readGoal();
  assert.equal(snapshot.exists, true);
  assert.equal(snapshot.goal, 'Legacy goal text');
  assert.equal(snapshot.paused, false);
});
