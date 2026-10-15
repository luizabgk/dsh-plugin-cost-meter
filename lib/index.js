/**
 * Entrada host do cost-meter (o `main` do pacote).
 *
 * O loader le `inject` deste modulo para saber que a rota HTTP precisa do
 * servico `webServer`; o corpo fica em lib/host.mjs.
 */
export { apply } from './host.mjs'

/** Servicos exigidos antes de ativar: a rota do relatorio vive no webServer. */
export const inject = ['webServer']
