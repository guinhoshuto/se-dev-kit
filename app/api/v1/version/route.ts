import {endpoint,json} from '@/lib/http';
import {HttpError} from '@/lib/errors';
import {deployedBuild} from '@/lib/build-info';
export const runtime='nodejs';
export const maxDuration=10;
/**
 * Read-only and capability-free: the build this deployment runs (package version, commit, dirty),
 * from the dist/build-info.json written during its build. `verify-hosted --wait-for <sha>` polls it
 * to learn when a push is live. Never cached.
 */
export async function GET(request:Request){return endpoint(request,async()=>{
  let build;
  try{build=await deployedBuild();}catch{throw new HttpError(503,'Build information is unavailable in this deployment.');}
  return json({schemaVersion:1,...build});
});}
