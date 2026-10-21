import { env } from 'cloudflare:workers';
import { handle } from '../../../lib/api.mjs';
export const dynamic='force-dynamic';
export const GET=(request:Request)=>handle(request,env);
export const POST=(request:Request)=>handle(request,env);
export const DELETE=(request:Request)=>handle(request,env);
