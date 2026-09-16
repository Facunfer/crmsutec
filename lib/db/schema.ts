import type { ColumnType, Generated } from "kysely";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
/**
 * jsonb: Postgres/PGlite lo devuelven ya parseado (T), pero para insertar o
 * actualizar hay que mandar el texto JSON crudo (`JSON.stringify(valor)`),
 * nunca el objeto de JS tal cual — así se refleja en los tipos de insert/update.
 */
export type JsonColumn<T extends Json = Json> = ColumnType<T, string, string>;
/**
 * Para columnas jsonb con default en la base (ej. '{}'::jsonb): el insert
 * es opcional. No envolver esto en `Generated<...>` — `Generated<T>` espera
 * que T sea el tipo de valor real, no otro ColumnType, y anidar dos
 * ColumnType rompe la inferencia de Kysely en `insertInto(...).values()`.
 */
export type JsonColumnWithDefault<T extends Json = Json> = ColumnType<T, string | undefined, string>;

export interface RolesTable {
  id: Generated<string>;
  key: string;
  name: string;
  is_system: Generated<boolean>;
  created_at: Generated<Date>;
}

export interface PermissionsTable {
  id: Generated<string>;
  key: string;
  description: string;
  created_at: Generated<Date>;
}

export interface RolePermissionsTable {
  role_id: string;
  permission_id: string;
}

export interface UsersTable {
  id: Generated<string>;
  email: string;
  password_hash: string;
  must_change_password: Generated<boolean>;
  full_name: string;
  role_id: string;
  status: Generated<"active" | "inactive">;
  permissions_version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
}

export interface SessionsTable {
  id: Generated<string>;
  user_id: string;
  token_hash: string;
  permissions_version_snapshot: number;
  ip_address: string | null;
  user_agent: string | null;
  created_at: Generated<Date>;
  expires_at: Date;
  revoked_at: Date | null;
}

export interface LoginAttemptsTable {
  id: Generated<string>;
  identifier: string;
  ip_address: string;
  succeeded: boolean;
  created_at: Generated<Date>;
}

export interface OrganizationTypesTable {
  id: Generated<string>;
  key: string;
  name: string;
  level: number;
  active: Generated<boolean>;
}

export interface OrganizationsTable {
  id: Generated<string>;
  type_id: string;
  parent_id: string | null;
  name: string;
  active: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type PersonStatus = "active" | "inactive" | "merged";
export type PersonOrigin = "manual" | "import" | "form";

export interface PeopleTable {
  id: Generated<string>;
  first_name: string;
  last_name: string;
  dni: string | null;
  email: string | null;
  phone: string | null;
  organization_id: string | null;
  birth_date: Date | null;
  declared_age: number | null;
  declared_age_at: Date | null;
  status: Generated<PersonStatus>;
  merged_into_id: string | null;
  custom_fields: JsonColumnWithDefault<Record<string, Json>>;
  origin: Generated<PersonOrigin>;
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
}

export type PersonFieldType =
  | "text"
  | "textarea"
  | "dni"
  | "phone"
  | "email"
  | "number"
  | "date"
  | "select"
  | "radio"
  | "checkbox"
  | "association";

export interface PersonFieldDefinitionsTable {
  id: Generated<string>;
  key: string;
  label: string;
  field_type: PersonFieldType;
  options: JsonColumn | null;
  required: Generated<boolean>;
  active: Generated<boolean>;
  sensitive: Generated<boolean>;
  sort_order: Generated<number>;
  created_at: Generated<Date>;
}

export interface AssociationTypesTable {
  id: Generated<string>;
  key: string;
  name: string;
  active: Generated<boolean>;
}

export interface AssociationsTable {
  id: Generated<string>;
  type_id: string;
  name: string;
  description: string | null;
  status: Generated<"active" | "inactive">;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
}

export interface AssociationManagersTable {
  id: Generated<string>;
  association_id: string;
  user_id: string | null;
  person_id: string | null;
  created_at: Generated<Date>;
}

export interface PeopleAssociationsTable {
  id: Generated<string>;
  person_id: string;
  association_id: string;
  role: string | null;
  status: Generated<"active" | "inactive">;
  added_at: Generated<Date>;
  added_by: string | null;
  removed_at: Date | null;
  removed_by: string | null;
}

export type MeetingStatus =
  | "draft"
  | "scheduled"
  | "in_progress"
  | "finished"
  | "cancelled"
  | "overdue_unclosed";

export interface MeetingsTable {
  id: Generated<string>;
  name: string;
  description: string | null;
  starts_at: Date;
  ends_at: Date;
  location_name: string | null;
  address: string | null;
  organizer_user_id: string | null;
  status: Generated<MeetingStatus>;
  qr_mode: Generated<"static" | "rotating">;
  qr_secret_version: Generated<number>;
  checkin_tolerance_before_minutes: Generated<number>;
  checkin_tolerance_after_minutes: Generated<number>;
  allow_uninvited_checkin: Generated<boolean>;
  notes: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
}

export interface MeetingAssociationsTable {
  meeting_id: string;
  association_id: string;
}

export interface MeetingInvitationBatchesTable {
  id: Generated<string>;
  meeting_id: string;
  criteria: JsonColumn;
  resolved_count: number;
  inserted_count: number;
  created_at: Generated<Date>;
  created_by: string | null;
}

export type InvitationResponseStatus = "pending" | "confirmed" | "declined";
export type InvitationAttendanceStatus = "unknown" | "attended" | "absent";

export interface MeetingInvitationsTable {
  id: Generated<string>;
  meeting_id: string;
  person_id: string;
  batch_id: string | null;
  token_hash: string;
  response_status: Generated<InvitationResponseStatus>;
  attendance_status: Generated<InvitationAttendanceStatus>;
  channel: Generated<string>;
  invited_at: Generated<Date>;
  responded_at: Date | null;
}

export interface MeetingAttendanceTable {
  id: Generated<string>;
  meeting_id: string;
  person_id: string;
  invitation_id: string | null;
  method: "invitation_token" | "dni" | "email" | "phone" | "manual";
  checked_in_at: Generated<Date>;
  ip_address: string | null;
  user_agent: string | null;
  registered_by: string | null;
  correction_reason: string | null;
}

export type FormStatus = "draft" | "published" | "unpublished" | "archived";

export interface FormsTable {
  id: Generated<string>;
  slug: string;
  name: string;
  status: Generated<FormStatus>;
  success_message: string | null;
  consent_text: string | null;
  opens_at: Date | null;
  closes_at: Date | null;
  identification_policy: JsonColumnWithDefault;
  update_policy: Generated<"fill_empty_only" | "always_flag_for_review">;
  published_version: number | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
}

export interface FormVersionsTable {
  id: Generated<string>;
  form_id: string;
  version: number;
  schema: JsonColumn;
  created_at: Generated<Date>;
}

export interface FormFieldsTable {
  id: Generated<string>;
  form_id: string;
  key: string;
  label: string;
  field_type: PersonFieldType;
  options: JsonColumn | null;
  required: Generated<boolean>;
  visible: Generated<boolean>;
  sort_order: Generated<number>;
  person_field_mapping: string | null;
}

export interface FormActionsTable {
  id: Generated<string>;
  form_id: string;
  action_type: "add_to_association";
  config: JsonColumn;
  sort_order: Generated<number>;
}

export type SubmissionMatchResult = "pending" | "created" | "matched" | "needs_review" | "error";

export interface FormSubmissionsTable {
  id: Generated<string>;
  form_id: string;
  form_version: number;
  raw_payload: JsonColumn;
  normalized_values: JsonColumnWithDefault;
  match_result: Generated<SubmissionMatchResult>;
  person_id: string | null;
  idempotency_key: string;
  ip_address: string | null;
  user_agent: string | null;
  error_message: string | null;
  created_at: Generated<Date>;
  processed_at: Date | null;
}

export interface PersonDuplicateCandidatesTable {
  id: Generated<string>;
  person_id: string | null;
  submission_id: string | null;
  match_reason: string;
  status: Generated<"pending" | "linked" | "created_new" | "discarded">;
  resolved_by: string | null;
  resolved_at: Date | null;
  created_at: Generated<Date>;
}

export interface NotificationOutboxTable {
  id: Generated<string>;
  channel: "manual_link" | "email" | "whatsapp" | "sms";
  recipient: string;
  payload: JsonColumn;
  status: Generated<"pending" | "sent" | "failed" | "not_applicable">;
  related_entity_type: string | null;
  related_entity_id: string | null;
  created_at: Generated<Date>;
  sent_at: Date | null;
}

export interface AuditLogsTable {
  id: Generated<string>;
  actor_user_id: string | null;
  actor_type: Generated<"user" | "public" | "system">;
  action: string;
  entity_type: string;
  entity_id: string | null;
  before: JsonColumn | null;
  after: JsonColumn | null;
  metadata: JsonColumn | null;
  created_at: Generated<Date>;
}

export interface AppSettingsTable {
  key: string;
  value: JsonColumn;
  updated_at: Generated<Date>;
  updated_by: string | null;
}

export interface SutecbaMetaTable {
  id: Generated<boolean>;
  system: string;
  created_at: Generated<Date>;
}

export interface SutecbaMigrationsTable {
  id: Generated<number>;
  filename: string;
  applied_at: Generated<Date>;
}

export interface Database {
  roles: RolesTable;
  permissions: PermissionsTable;
  role_permissions: RolePermissionsTable;
  users: UsersTable;
  sessions: SessionsTable;
  login_attempts: LoginAttemptsTable;
  organization_types: OrganizationTypesTable;
  organizations: OrganizationsTable;
  people: PeopleTable;
  person_field_definitions: PersonFieldDefinitionsTable;
  association_types: AssociationTypesTable;
  associations: AssociationsTable;
  association_managers: AssociationManagersTable;
  people_associations: PeopleAssociationsTable;
  meetings: MeetingsTable;
  meeting_associations: MeetingAssociationsTable;
  meeting_invitation_batches: MeetingInvitationBatchesTable;
  meeting_invitations: MeetingInvitationsTable;
  meeting_attendance: MeetingAttendanceTable;
  forms: FormsTable;
  form_versions: FormVersionsTable;
  form_fields: FormFieldsTable;
  form_actions: FormActionsTable;
  form_submissions: FormSubmissionsTable;
  person_duplicate_candidates: PersonDuplicateCandidatesTable;
  notification_outbox: NotificationOutboxTable;
  audit_logs: AuditLogsTable;
  app_settings: AppSettingsTable;
  sutecba_meta: SutecbaMetaTable;
  sutecba_migrations: SutecbaMigrationsTable;
}
