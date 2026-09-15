import {sleep} from 'workflow';

async function launch(projectId: string, jobId: string) {
  'use step';
  const {launchHostedJob} = await import('../lib/jobs');
  await launchHostedJob(projectId, jobId);
}
async function poll(projectId: string, jobId: string) {
  'use step';
  const {pollHostedJob} = await import('../lib/jobs');
  return pollHostedJob(projectId, jobId);
}
async function fail(projectId: string, jobId: string, message: string) {
  'use step';
  const {failHostedJob} = await import('../lib/jobs');
  await failHostedJob(projectId, jobId, message);
}
export async function renderWorkflow(projectId: string, jobId: string) {
  'use workflow';
  try {
    await launch(projectId, jobId);
    for (let attempt = 0; attempt < 60; attempt++) {
      await sleep('10s');
      if (await poll(projectId, jobId)) return;
    }
    await fail(projectId, jobId, 'Job exceeded the 10 minute execution limit.');
  } catch (error) {
    await fail(projectId, jobId, error instanceof Error ? error.message : 'Workflow failed.');
  }
}
