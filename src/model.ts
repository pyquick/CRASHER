export interface CrashGroup {
  id: number;
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
  exception_type: string;
  exception_message: string;
  stack_trace: string;
  log_text: string;
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
}

export interface CrashReportInput {
  exception_type: string;
  exception_message?: string;
  stack_trace?: string;
  log_text?: string;
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
  daily_trend: Array<{
    date: string;
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
  status?: string;
  platform?: string;
  app_version?: string;
  search?: string;
  start_date?: string;
  end_date?: string;
  sort_by?: string;
  sort_order?: 'asc' | 'desc';
}
