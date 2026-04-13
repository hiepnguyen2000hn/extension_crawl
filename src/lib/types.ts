// src/lib/types.ts

export interface Session {
  csrfToken: string
  liIdentity: string
}

export interface LeadPosition {
  title?: string
  companyName?: string
  companyUrn?: string
  current?: boolean
  startedOn?: unknown
  endedOn?: unknown
}

export interface LeadArtifact {
  width: number
  fileIdentifyingUrlPathSegment: string
}

export interface LeadProfilePicture {
  artifacts?: LeadArtifact[]
  rootUrl?: string
}

export interface LinkedInLeadElement {
  firstName?: string
  lastName?: string
  fullName?: string
  geoRegion?: string
  headline?: string
  summary?: string
  entityUrn?: string
  flagshipProfileUrl?: string
  premium?: boolean
  openToOpportunities?: boolean
  profilePictureDisplayImage?: LeadProfilePicture
  currentPositions?: LeadPosition[]
}

export interface MappedLead {
  firstName: string
  lastName: string
  fullName: string
  job_title: string
  location: string
  country: string
  salesNavigatorUrl: string
  linkedUrl: string
  company_name: string
  company_linkedin: string
  premium: string
  openToWork: string
  occupation: string
  profilePicture: string
  entityUrn: string
  importDate: string
}

export interface CrawlProgress {
  type: 'CRAWL_LEAD_PROGRESS'
  phase: 'fetch' | 'enrich' | 'done' | 'error'
  fetched?: number
  total?: number
  current?: number
  message?: string
}

export interface CrawlResult {
  type: 'CRAWL_LEAD_RESULT'
  ok: boolean
  count?: number
  error?: string
}

export interface CompanyElement {
  companyName?: string
  entityUrn?: string
  employeeCount?: number
  employeeCountRange?: { start?: number; end?: number }
  industries?: Array<{ localizedName?: string }>
  headquartersLocation?: {
    city?: string
    geographicArea?: string
    country?: string
    postalCode?: string
  }
  website?: string
  description?: string
  companyPictureDisplayImage?: {
    artifacts?: Array<{ width: number; fileIdentifyingUrlPathSegment: string }>
    rootUrl?: string
  }
  _absIndex?: number
}

export interface CompanyDetail {
  companyName?: string
  description?: string
  website?: string
  phone?: string
  foundedOn?: { year?: number }
  employeeCount?: number
  employeeCountRange?: { start?: number; end?: number }
  industries?: Array<{ localizedName?: string }>
  headquartersLocation?: {
    city?: string
    geographicArea?: string
    country?: string
  }
  linkedInUrl?: string
  flagshipCompanyUrl?: string
  revenue?: { amount?: string; currencyCode?: string }
}

export interface MappedCompany {
  company_name: string
  company_linkedin: string
  website: string
  industry: string
  employee_count: string
  employee_range: string
  city: string
  region: string
  country: string
  description: string
  phone: string
  founded_year: string
  revenue: string
  entityUrn: string
  importDate: string
}

export interface CompanyCrawlProgress {
  type: 'CRAWL_COMPANY_PROGRESS'
  phase: 'fetch' | 'enrich' | 'done' | 'error'
  fetched?: number
  total?: number
  current?: number
  message?: string
}

export interface CompanyCrawlResult {
  type: 'CRAWL_COMPANY_RESULT'
  ok: boolean
  count?: number
  error?: string
}

export interface CrawlCSVReady {
  type: 'CRAWL_LEAD_CSV' | 'CRAWL_COMPANY_CSV'
  csv: string
  filename: string
  count: number
}

export type LogLevel  = 'info' | 'warn' | 'error'
export type LogSource = 'lead' | 'company' | 'system'

export interface LogEntry {
  type: 'LOG_ENTRY'
  level: LogLevel
  source: LogSource
  text: string
  ts: number
}
