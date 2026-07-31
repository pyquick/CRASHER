export type UserRole = 'admin' | 'operator' | 'viewer';
export type ApiKeyTier = 'admin' | 'operator' | 'viewer';

export interface User {
  id: number;
  username: string;
  password_hash: string;
  role: UserRole;
  is_active: number;
  session_version: number;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
}

export interface AuthenticatedUser {
  id: number;
  username: string;
  role: UserRole;
}

export interface ApiKeyRecord {
  id: number;
  user_id: number;
  name: string;
  key_prefix: string;
  key_hash: string;
  tier: ApiKeyTier;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

export interface PlayerFeedback {
  id: number;
  title: string;
  description: string;
  category: 'bug' | 'suggestion' | 'other';
  severity: 'low' | 'normal' | 'high' | 'critical';
  status: 'new' | 'in_progress' | 'resolved' | 'closed';
  player_id: string;
  player_name: string;
  contact: string;
  app_version: string;
  platform: string;
  device_model: string;
  scene_name: string;
  custom_data: string;
  client_ip: string;
  client_timestamp: string;
  created_at: string;
  updated_at: string;
}

export interface PlayerFeedbackInput {
  title: string;
  description: string;
  category?: 'bug' | 'suggestion' | 'other';
  severity?: 'low' | 'normal' | 'high' | 'critical';
  player_id?: string;
  player_name?: string;
  contact?: string;
  app_version?: string;
  platform?: string;
  device_model?: string;
  scene_name?: string;
  custom_data?: Record<string, unknown> | string;
  client_timestamp?: string;
}

export interface FeedbackAttachment {
  id: number;
  feedback_id: number;
  filename: string;
  content_type: string;
  file_size: number;
  file_path: string;
  created_at: string;
}

export interface Project {
  id: number;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface SourceSnapshot {
  id: number;
  project_id: number;
  release: string;
  created_at: string;
}

export interface SourceFile {
  id: number;
  snapshot_id: number;
  relative_path: string;
  storage_path: string;
  file_size: number;
  language: string;
  created_at: string;
}

export interface CrashGroup {
  id: number;
  project_id: number | null;
  project_name?: string;
  crash_hash: string;
  exception_type: string;
  exception_message: string;
  first_seen: string;
  last_seen: string;
  total_count: number;
  status: 'open' | 'resolved' | 'ignored';
  resolved_version: string;
  created_at: string;
}

export interface CrashReport {
  id: number;
  group_id: number | null;
  project_id: number | null;
  project_name?: string;
  exception_type: string;
  exception_message: string;
  stack_trace: string;
  log_text: string;
  runtime: string;
  runtime_version: string;
  framework: string;
  environment: string;
  server_name: string;
  release: string;
  error_severity: string;
  unity_version: string;
  platform: string;
  device_model: string;
  os_version: string;
  gpu_name: string;
  cpu_name: string;
  memory_mb: number;
  app_version: string;
  bundle_id: string;
  scene_name: string;
  custom_data: string;
  client_ip: string;
  client_timestamp: string;
  created_at: string;
  dump_info: string;
  build_guid: string;
  symbolicated_stack: string;
  symbolication_info: string;
  symbolication_status: string;
  symbol_id: number | null;
}

export interface CrashReportInput {
  exception_type: string;
  project_name?: string;
  exception_message?: string;
  stack_trace?: string;
  log_text?: string;
  // Generic runtime fields (unified crash reporter)
  runtime?: string;
  runtime_version?: string;
  framework?: string;
  environment?: string;
  server_name?: string;
  release?: string;
  error_severity?: string;
  // Original fields (backward compatible)
  unity_version?: string;
  platform?: string;
  device_model?: string;
  os_version?: string;
  gpu_name?: string;
  cpu_name?: string;
  memory_mb?: number;
  app_version?: string;
  bundle_id?: string;
  scene_name?: string;
  custom_data?: Record<string, unknown> | string;
  client_timestamp?: string;
  build_guid?: string;
}

export interface CrashAttachment {
  id: number;
  crash_report_id: number;
  filename: string;
  content_type: string;
  file_size: number;
  file_path: string;
  created_at: string;
}

export interface Symbol {
  id: number;
  platform: string;
  build_guid: string;
  filename: string;
  file_size: number;
  file_path: string;
  uploaded_at: string;
  symbol_type?: string;
  module_name?: string;
  architecture?: string;
  index_status?: string;
  index_error?: string;
}

export interface DashboardStats {
  total_crashes: number;
  total_groups: number;
  open_groups: number;
  resolved_groups: number;
  crashes_today: number;
  crashes_week: number;
  top_crashes: Array<{
    group_id: number;
    exception_type: string;
    exception_message: string;
    count: number;
    last_seen: string;
  }>;
  platform_distribution: Array<{
    platform: string;
    count: number;
  }>;
  version_distribution: Array<{
    app_version: string;
    count: number;
  }>;
  runtime_distribution: Array<{
    runtime: string;
    count: number;
  }>;
  daily_trend: Array<{
    date: string;
    count: number;
  }>;
  environment_distribution: Array<{
    environment: string;
    count: number;
  }>;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
}

export interface CrashGroupQuery {
  page?: number;
  page_size?: number;
  project_id?: number;
  status?: string;
  platform?: string;
  app_version?: string;
  runtime?: string;
  environment?: string;
  error_severity?: string;
  search?: string;
  start_date?: string;
  end_date?: string;
  sort_by?: string;
  sort_order?: 'asc' | 'desc';
}
