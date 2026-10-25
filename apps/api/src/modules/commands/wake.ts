// Aviso inmediato a n8n de que hay comandos nuevos (p. ej., tras confirmar una cita). Si falla, el disparador
// del workflow «Comandos durables» los recoge en ≤ 30 s: el aviso solo reduce la espera, no es necesario para la entrega.
export interface WakeConfig { url?: string; secret?: string }

export function wakeCommands(cfg: WakeConfig, reason: string) {
  if (!cfg.url || !cfg.secret) return;
  void fetch(cfg.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-saludcita-webhook-secret': cfg.secret },
    // No bloquea la respuesta al paciente; 15 s de margen para que el aviso no se pierda si n8n tarda en atenderlo
    body: JSON.stringify({ reason }), signal: AbortSignal.timeout(15000) }).catch(() => undefined);
}
