import type { FastifyRequest } from "fastify";
import { config } from "./config.js";

export async function requireApiKey(request:FastifyRequest) {
  const key = request.headers["x-api-key"];
  if (key !== config.API_KEY) {
    const err = new Error("Unauthorized") as Error & { statusCode?:number };
    err.statusCode = 401;
    throw err;
  }
}
