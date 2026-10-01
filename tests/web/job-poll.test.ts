import test from 'node:test';
import assert from 'node:assert/strict';
import {jobPath, readActiveJobs, replaceJobs} from '../../lib/job-poll';
import type {Job} from '../../lib/model';

const job = (id: string, status: Job['status'], progress = status): Job => ({id, projectId: 'project-a', revisionId: 'revision-a', kind: 'render', selection: 'default', status, createdAt: '2025-01-15T12:00:00.000Z', updatedAt: '2025-01-15T12:00:00.000Z', progress, artifacts: []});

test('the editor polls each active job on its own route and never the job list', async () => {
  const jobs = [job('queued-job', 'queued'), job('done-job', 'completed'), job('running-job', 'running'), job('failed-job', 'failed'), job('cancelled-job', 'cancelled')];
  const paths: string[] = [];
  const fresh = await readActiveJobs('project-a', jobs, async path => {paths.push(path); return job(path.split('/').pop()!, 'completed', 'Done');});
  assert.deepEqual(paths, ['/api/studio/projects/project-a/jobs/queued-job', '/api/studio/projects/project-a/jobs/running-job']);
  assert.deepEqual(fresh.map(item => [item.id, item.status]), [['queued-job', 'completed'], ['running-job', 'completed']]);
  assert.deepEqual(await readActiveJobs('project-a', [job('done-job', 'completed')], async () => assert.fail('a finished job was read again')), []);
  assert.equal(jobPath('project a', 'job/1'), '/api/studio/projects/project%20a/jobs/job%2F1');
});

test('replaceJobs swaps in the polled records and keeps order and jobs queued meanwhile', () => {
  const added = job('new-job', 'queued');
  const before = [added, job('running-job', 'running'), job('done-job', 'completed')];
  const after = replaceJobs(before, [job('running-job', 'completed', 'Done'), job('gone-job', 'completed')]);
  assert.deepEqual(after.map(item => [item.id, item.status]), [['new-job', 'queued'], ['running-job', 'completed'], ['done-job', 'completed']]);
  assert.equal(after[0], added);
});
