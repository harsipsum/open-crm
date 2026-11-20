import { createServerFn } from "@tanstack/react-start";
import { CompanyTechService } from "@/server/features/tech/services/CompanyTechService";
import { requireAuthenticatedContext } from "@/serverFunctions/middleware";
import {
  addCompanyTechSchema,
  companyTechIdSchema,
  companyTechListSchema,
} from "@/types/schemas/tech";

// A company's tech stack: members see and change it as they do the company.

export const listCompanyTech = createServerFn({ method: "GET" })
  .middleware(requireAuthenticatedContext)
  .validator(companyTechListSchema)
  .handler(({ data, context }) =>
    CompanyTechService.list(context.organizationId, data.companyId),
  );

export const addCompanyTech = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .validator(addCompanyTechSchema)
  .handler(({ data, context }) =>
    CompanyTechService.add(context.organizationId, context.userId, data),
  );

export const confirmCompanyTech = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .validator(companyTechIdSchema)
  .handler(({ data, context }) =>
    CompanyTechService.confirm(context.organizationId, context.userId, data.id),
  );

export const archiveCompanyTech = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .validator(companyTechIdSchema)
  .handler(({ data, context }) =>
    CompanyTechService.archive(context.organizationId, context.userId, data.id),
  );
