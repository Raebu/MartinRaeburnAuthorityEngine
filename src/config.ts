import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development","test","production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_URL: z.string().min(1),
  API_KEY: z.string().min(12),
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:8080"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-5.6-mini"),
  RESEND_API_KEY: z.string().optional(),
  OUTREACH_FROM: z.string().default("Martin Raeburn <contact@martinraeburn.com>"),
  OUTREACH_REPLY_TO: z.string().email().default("contact@martinraeburn.com"),
  DISCOVERY_FEEDS: z.string().default(""),
  SITE_BASE_URL: z.string().url().default("https://www.martinraeburn.com"),
  SITE_MONITOR_PATHS: z.string().default("/,/about/,/the-group/,/work/,/speaking/,/connect/,/thinking/,/robots.txt,/sitemap.xml"),
  DISCOVERY_INTERVAL_MINUTES: z.coerce.number().int().positive().default(180),
  SITE_MONITOR_INTERVAL_MINUTES: z.coerce.number().int().positive().default(30)
});

export const config = schema.parse(process.env);
export const discoveryFeeds = config.DISCOVERY_FEEDS.split(",").map(v=>v.trim()).filter(Boolean);
export const sitePaths = config.SITE_MONITOR_PATHS.split(",").map(v=>v.trim()).filter(Boolean);
