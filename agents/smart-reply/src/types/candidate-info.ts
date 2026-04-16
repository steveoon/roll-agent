import { z } from "zod";

export const CandidateInfoSchema = z.object({
  name: z.string().optional(),
  position: z.string().optional(),
  expectedPosition: z.string().optional(),
  communicationPosition: z.string().optional(),
  age: z.string().optional(),
  gender: z.string().optional(),
  experience: z.string().optional(),
  education: z.string().optional(),
  expectedSalary: z.string().optional(),
  expectedLocation: z.string().optional(),
  jobAddress: z.string().optional(),
  height: z.string().optional(),
  weight: z.string().optional(),
  healthCertificate: z.boolean().optional(),
  activeTime: z.string().optional(),
  info: z.array(z.string()).optional(),
  fullText: z.string().optional(),
});

export type CandidateInfo = z.infer<typeof CandidateInfoSchema>;
