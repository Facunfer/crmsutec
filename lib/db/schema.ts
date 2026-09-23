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

export interface ModulesTable {
  key: string;
  name: string;
  sort_order: Generated<number>;
  active: Generated<boolean>;
}

export interface PermissionsTable {
  id: Generated<string>;
  key: string;
  description: string;
  module_key: string;
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
  /** Afiliación organizativa (informativa). NO otorga acceso: eso lo define user_scopes. */
  primary_organization_id: string | null;
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

export interface PublicLinkAttemptsTable {
  id: Generated<string>;
  scope: string;
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
  official_code: string | null;
  valid_from: Date | null;
  valid_to: Date | null;
  active: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface OrganizationAliasesTable {
  id: Generated<string>;
  organization_id: string;
  /** 0022: NULL = alias global; con valor = alias contextual (solo vale dentro de esa organización). */
  context_organization_id: string | null;
  alias: string;
  /** La completa el trigger de la base (minúsculas, sin acentos). */
  normalized_alias: Generated<string>;
  status: Generated<"pending" | "approved" | "rejected">;
  approved_by: string | null;
  approved_at: Date | null;
  created_by: string | null;
  created_at: Generated<Date>;
}

export interface UserScopesTable {
  id: Generated<string>;
  user_id: string;
  organization_id: string;
  include_descendants: Generated<boolean>;
  granted_by: string;
  granted_at: Generated<Date>;
  revoked_at: Date | null;
  revoked_by: string | null;
}

export interface UserModulesTable {
  id: Generated<string>;
  user_id: string;
  module_key: string;
  granted_by: string;
  granted_at: Generated<Date>;
  revoked_at: Date | null;
  revoked_by: string | null;
}

export type PersonStatus = "active" | "inactive" | "merged";
export type PersonOrigin = "manual" | "import" | "form";

export interface PeopleTable {
  id: Generated<string>;
  first_name: string;
  last_name: string;
  /** Obligatorio (0021): 7 u 8 dígitos, único entre personas no fusionadas. */
  dni: string;
  /** Sensible. Columna independiente del DNI; nunca identificador principal (0021). */
  cuil_cuit: string | null;
  /** Procedencia del DNI (0021): explícito o derivado de cuil_cuit. El origen de la persona está en `origin`. */
  dni_source: Generated<"explicit" | "derived_from_cuil">;
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
  owner_organization_id: string;
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

export type MeetingType = "reunion" | "capacitacion" | "operativo_salud" | "jornada" | "evento" | "otro";
export type MeetingSchedulePrecision = "exact_datetime" | "date_only" | "unknown";

export interface MeetingsTable {
  id: Generated<string>;
  owner_organization_id: string;
  name: string;
  description: string | null;
  /** NULL solo en eventos importados sin hora conocida (0021, schedule_precision). */
  starts_at: Date | null;
  ends_at: Date | null;
  meeting_type: Generated<MeetingType>;
  meeting_subtype: string | null;
  origin: Generated<"manual" | "import">;
  source_event_key: string | null;
  import_batch_id: string | null;
  schedule_precision: Generated<MeetingSchedulePrecision>;
  event_date: Date | null;
  source_time_note: string | null;
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
  withdrawn_at: Date | null;
  withdrawn_by: string | null;
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
  owner_organization_id: string;
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
  source: Generated<"form" | "import">;
  import_row_id: string | null;
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

export interface PersonOrganizationTransfersTable {
  id: Generated<string>;
  person_id: string;
  from_organization_id: string | null;
  to_organization_id: string;
  reason: string;
  transferred_by: string;
  transferred_at: Generated<Date>;
}

export interface TagsTable {
  id: Generated<string>;
  name: string;
  /** La completa el trigger de la base. */
  normalized_name: Generated<string>;
  category: string | null;
  is_controlled: Generated<boolean>;
  is_sensitive: Generated<boolean>;
  owner_organization_id: string | null;
  active: Generated<boolean>;
  created_by: string;
  created_at: Generated<Date>;
}

export interface PersonTagsTable {
  id: Generated<string>;
  person_id: string;
  tag_id: string;
  assigned_by: string;
  assigned_at: Generated<Date>;
  removed_at: Date | null;
  removed_by: string | null;
}

export interface InteractionTypesTable {
  id: Generated<string>;
  key: string;
  name: string;
  active: Generated<boolean>;
  sort_order: Generated<number>;
}

export interface InteractionChannelsTable {
  id: Generated<string>;
  key: string;
  name: string;
  active: Generated<boolean>;
  sort_order: Generated<number>;
}

export type InteractionStatus = "open" | "completed" | "cancelled" | "voided";

export interface PersonInteractionsTable {
  id: Generated<string>;
  person_id: string;
  owner_organization_id: string;
  occurred_at: Date;
  /** date_only: occurred_at es el inicio del día (00:00 Buenos Aires); no se inventa una hora. */
  occurred_precision: Generated<"exact_datetime" | "date_only">;
  /** Clave lógica de las interacciones automáticas (idempotencia): meeting_participation:<id> | meeting_attendance:<id>. */
  source_key: string | null;
  interaction_type_id: string;
  channel_id: string | null;
  subject: string;
  description: string | null;
  status: Generated<InteractionStatus>;
  outcome: string | null;
  responsible_user_id: string | null;
  next_follow_up_at: Date | null;
  meeting_id: string | null;
  void_reason: string | null;
  created_by: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  version: Generated<number>;
}

export interface AssociationInteractionsTable {
  id: Generated<string>;
  association_id: string;
  contact_person_id: string | null;
  owner_organization_id: string;
  occurred_at: Date;
  interaction_type_id: string;
  channel_id: string | null;
  subject: string;
  description: string | null;
  status: Generated<InteractionStatus>;
  outcome: string | null;
  responsible_user_id: string | null;
  next_follow_up_at: Date | null;
  meeting_id: string | null;
  void_reason: string | null;
  created_by: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  version: Generated<number>;
}

export interface InteractionLinksTable {
  id: Generated<string>;
  person_interaction_id: string;
  association_interaction_id: string;
  created_by: string;
  created_at: Generated<Date>;
}

export type ImportBatchStatus =
  | "staged"
  | "processing"
  | "in_review"
  | "approved"
  | "applied"
  | "failed"
  | "cancelled";

export interface ImportBatchesTable {
  id: Generated<string>;
  owner_organization_id: string;
  responsible_user_id: string;
  status: Generated<ImportBatchStatus>;
  created_at: Generated<Date>;
  started_at: Date | null;
  completed_at: Date | null;
  created_by: string;
  notes: string | null;
  /** 0021: auditoría del apply. 'apply' + status 'applied' = importación real; nunca datos personales en `summary`. */
  execution_mode: "dry_run" | "apply" | null;
  plan_hash: string | null;
  source_system: string | null;
  sutecba_env: string | null;
  applied_at: Date | null;
  summary: unknown | null;
}

export interface ImportFilesTable {
  id: Generated<string>;
  original_name: string;
  content_hash: string;
  external_reference: string | null;
  created_by: string;
  created_at: Generated<Date>;
  size_bytes: number | null;
  source_metadata: JsonColumnWithDefault<Record<string, Json>>;
}

export interface ImportBatchFilesTable {
  batch_id: string;
  file_id: string;
  linked_by: string;
  linked_at: Generated<Date>;
}

export type ParticipationKind = "registration" | "invited" | "attended" | "absent" | "approved" | "unknown" | "participated";
/** 'standard': flujo normal (invitación, check-in, corrección manual). 'legacy_initial_import': decisión de negocio
 * exclusiva de la carga histórica inicial de Gabriel (solo junto con participation_kind='participated'). */
export type ParticipationBasis = "standard" | "legacy_initial_import";

export type ImportRowStatus =
  | "staged"
  | "normalized"
  | "in_review"
  | "approved"
  | "applied"
  | "rejected"
  | "skipped";

export interface ImportRowsTable {
  id: Generated<string>;
  file_id: string;
  sheet: Generated<string>;
  row_number: number;
  raw_data: JsonColumn;
  normalized_data: JsonColumnWithDefault;
  row_hash: string;
  duplicate_of_row_id: string | null;
  status: Generated<ImportRowStatus>;
  updated_at: Generated<Date>;
  source_file_code: string | null;
  normalized_dni: string | null;
  dni_source: "explicit" | "derived_from_cuil" | null;
  normalized_cuil_cuit: string | null;
  person_id: string | null;
  meeting_id: string | null;
  campaign_key: string | null;
  participation_kind: ParticipationKind | null;
}

export interface ImportIssuesTable {
  id: Generated<string>;
  batch_id: string;
  import_row_id: string;
  severity: "warning" | "error";
  code: string;
  message: string;
  status: Generated<"open" | "resolved" | "dismissed">;
  resolved_by: string | null;
  resolved_at: Date | null;
  created_at: Generated<Date>;
}

export interface ImportEntityLinksTable {
  id: Generated<string>;
  import_row_id: string;
  entity_type: string;
  entity_id: string;
  linked_by: string;
  linked_at: Generated<Date>;
}

export interface MeetingParticipationsTable {
  id: Generated<string>;
  meeting_id: string | null;
  campaign_key: string | null;
  person_id: string;
  participation_kind: ParticipationKind;
  evidence: string | null;
  import_row_id: string | null;
  created_at: Generated<Date>;
  participation_basis: Generated<ParticipationBasis>;
}

export interface Database {
  roles: RolesTable;
  modules: ModulesTable;
  permissions: PermissionsTable;
  role_permissions: RolePermissionsTable;
  users: UsersTable;
  sessions: SessionsTable;
  login_attempts: LoginAttemptsTable;
  public_link_attempts: PublicLinkAttemptsTable;
  organization_types: OrganizationTypesTable;
  organizations: OrganizationsTable;
  organization_aliases: OrganizationAliasesTable;
  user_scopes: UserScopesTable;
  user_modules: UserModulesTable;
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
  app_settings: AppSettingsTable;
  person_organization_transfers: PersonOrganizationTransfersTable;
  tags: TagsTable;
  person_tags: PersonTagsTable;
  interaction_types: InteractionTypesTable;
  interaction_channels: InteractionChannelsTable;
  person_interactions: PersonInteractionsTable;
  association_interactions: AssociationInteractionsTable;
  interaction_links: InteractionLinksTable;
  import_batches: ImportBatchesTable;
  import_files: ImportFilesTable;
  import_batch_files: ImportBatchFilesTable;
  import_rows: ImportRowsTable;
  import_issues: ImportIssuesTable;
  import_entity_links: ImportEntityLinksTable;
  meeting_participations: MeetingParticipationsTable;
  sutecba_meta: SutecbaMetaTable;
  sutecba_migrations: SutecbaMigrationsTable;
}
