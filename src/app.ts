import Fastify from "fastify";
import cors from "@fastify/cors";
import { registerRoutes } from "./routes.js";

export async function buildApp() {
  const app=Fastify({
    logger:{level:process.env.NODE_ENV==="production"?"info":"debug"},
    bodyLimit:1_000_000,
    requestTimeout:30_000
  });
  await app.register(cors,{origin:false});
  await registerRoutes(app);
  app.setErrorHandler((err:any,_req,reply)=>{
    const code=(err as any).statusCode && Number((err as any).statusCode)>=400 ? Number((err as any).statusCode) : 500;
    reply.code(code).send({error:code===500?"Internal server error":err.message});
  });
  return app;
}
