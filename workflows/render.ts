import {sleep} from 'workflow';
import type {PollOutcome} from '../lib/jobs';

async function launch(projectId: string, jobId: string) {
  'use step';
  const {launchHostedJob} = await import('../lib/jobs');
  await launchHostedJob(projectId, jobId);
}
async function poll(projectId: string, jobId: string): Promise<PollOutcome> {
  'use step';
  const {pollHostedJob} = await import('../lib/jobs');
  return pollHostedJob(projectId, jobId);
}
/** A pass found Google Fonts outside the job package: fetch them through the proxy and run the next pass. */
async function refill(projectId: string, jobId: string, pass: number) {
  'use step';
  const {refillHostedJob} = await import('../lib/jobs');
  await refillHostedJob(projectId, jobId, pass);
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
      const outcome = await poll(projectId, jobId);
      if (outcome.state === 'done') return;
      // The pass limit and the remaining job time are enforced in the step (FONT_DISCOVERY_LIMIT).
      if (outcome.state === 'refill') await refill(projectId, jobId, outcome.pass);
    }
    await fail(projectId, jobId, 'Job exceeded the 10 minute execution limit.');
  } catch (error) {
    await fail(projectId, jobId, error instanceof Error ? error.message : 'Workflow failed.');
  }
}
