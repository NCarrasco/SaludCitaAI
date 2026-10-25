import { Type, type Static } from 'typebox';

// Esquemas compartidos por rutas y por el contrato OpenAPI generado.

export const Uuid = Type.String({ format: 'uuid' });
export const DateTime = Type.String({ format: 'date-time', description: 'RFC 3339 con desplazamiento' });
export const LocalDate = Type.String({ format: 'date', description: 'Fecha local AAAA-MM-DD' });

export const ErrorResponse = Type.Object({
  error: Type.Object({
    code: Type.String(),
    message: Type.String(),
    details: Type.Record(Type.String(), Type.Unknown()),
  }),
  request_id: Type.String(),
}, { $id: 'ErrorResponse', title: 'ErrorResponse' });

export const errorResponses = (...codes: number[]) =>
  Object.fromEntries(codes.map((c) => [c, Type.Ref('ErrorResponse')]));

export const NamedRef = Type.Object({ id: Uuid, name: Type.String() });

export const CenterRef = Type.Object({ id: Uuid, name: Type.String(), address: Type.Union([Type.String(), Type.Null()]) });

export const SlotView = Type.Object({
  slot_id: Uuid,
  doctor_service_id: Uuid,
  starts_at: DateTime,
  ends_at: DateTime,
  label: Type.String({ description: 'Fecha completa en español y zona de negocio' }),
  timezone: Type.String(),
  doctor: Type.Object({ id: Uuid, display_name: Type.String() }),
  specialty: NamedRef,
  center: CenterRef,
  consultation_kind: Type.Union([Type.Literal('initial'), Type.Literal('follow_up')]),
  patient_instructions: Type.Union([Type.String(), Type.Null()]),
}, { $id: 'SlotView', title: 'SlotView' });
export type SlotViewT = Static<typeof SlotView>;

export const AppointmentStatus = Type.Union([
  Type.Literal('booked'), Type.Literal('cancelled'), Type.Literal('completed'), Type.Literal('no_show'),
]);

export const AppointmentView = Type.Object({
  id: Uuid,
  booking_reference: Type.String({ description: 'Referencia para mostrar; no autentica ni autoriza acceso' }),
  status: AppointmentStatus,
  version: Type.Integer({ minimum: 1 }),
  advance_opt_in: Type.Boolean(),
  booked_at: DateTime,
  cancelled_at: Type.Union([DateTime, Type.Null()]),
  cancellation_reason_code: Type.Union([Type.String(), Type.Null()]),
  slot: Type.Ref('SlotView'),
}, { $id: 'AppointmentView', title: 'AppointmentView' });
export type AppointmentViewT = Omit<Static<typeof AppointmentView>, 'slot'> & { slot: SlotViewT };

export const PatientView = Type.Object({
  id: Uuid,
  full_name: Type.Union([Type.String(), Type.Null()]),
  birth_date: Type.Union([LocalDate, Type.Null()]),
  phone: Type.Union([Type.String(), Type.Null()], { description: 'Teléfono de contacto. No sirve para identificarse' }),
  email: Type.Union([Type.String(), Type.Null()], { description: 'Correo de contacto. No sirve para identificarse' }),
  profile_complete: Type.Boolean({ description: 'Tiene nombre, fecha de nacimiento y un contacto (teléfono o correo): lo necesario para reservar' }),
  kind: Type.Union([Type.Literal('account'), Type.Literal('guest')], { description: 'guest = sesión invitada sin registro previo' }),
}, { $id: 'PatientView', title: 'PatientView' });

export const sharedSchemas = [ErrorResponse, SlotView, AppointmentView, PatientView];

export const BearerSecurity = [{ bearerAuth: [] }];
