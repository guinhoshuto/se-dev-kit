import type {Job} from './model';

/** The route that returns one job; polling it reads the project and that job's record only. */
export const jobPath=(projectId:string,jobId:string)=>`/api/studio/projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}`;
export const isActiveJob=(job:Job)=>job.status==='queued'||job.status==='running';
/** Reads each queued or running job from its own route; finished jobs are not read again. */
export async function readActiveJobs(projectId:string,jobs:readonly Job[],read:(path:string)=>Promise<Job>):Promise<Job[]> {
  return Promise.all(jobs.filter(isActiveJob).map(job=>read(jobPath(projectId,job.id))));
}
/** Replaces the jobs that were read, keeping the order and any job added meanwhile. */
export function replaceJobs(jobs:readonly Job[],fresh:readonly Job[]):Job[] {
  const byId=new Map(fresh.map(job=>[job.id,job]));
  return jobs.map(job=>byId.get(job.id)??job);
}
