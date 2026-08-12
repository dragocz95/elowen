/** whatsapp — browser UI bundle.
 *
 *  Registers the plugin's settings-deck section (the pairing QR/unpair controls, moved out of the
 *  core Settings app) on the host's plugin-UI runtime. Built by @elowen/plugin-ui-kit (esbuild; react
 *  shimmed to the host instance) into web/index.js, which the manifest's `web.entry` points at.
 */
import { registerWhatsAppUi } from './runtime';
import { PairingSettings } from './PairingSettings';

registerWhatsAppUi({
  requiresApiVersion: 1,
  settings: {
    'pairing': PairingSettings,
  },
});
