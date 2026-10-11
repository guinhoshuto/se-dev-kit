import {endpoint,json} from '@/lib/http';
import {getStore} from '@/lib/storage';
import {activeJobs} from '@/lib/projects';
export const runtime='nodejs';
export const maxDuration=10;
/**
 * Read-only and capability-free: how many jobs of every project hold a lease on this Studio, and nothing about them.
 * A local job runs inside the server process, so a session that started the local Studio asks this before stopping
 * it (studio-client.mjs active). Never cached.
 */
export async function GET(request:Request){return endpoint(request,async()=>json({schemaVersion:1,activeJobs:await activeJobs(getStore())}));}
