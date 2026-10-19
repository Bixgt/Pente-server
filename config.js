/* Configuración del modo online.
 * Dirección del servidor de partidas (empieza con wss://). Dejalo vacío para jugar sin modo online. */
window.PENTE_SERVER = 'wss://pente-server.onrender.com';

/* Cuenta y perfil en la nube (Supabase). La clave "publishable" es pública por diseño: lo que protege los datos son las reglas de seguridad (RLS) de supabase/schema.sql.
 * Dejalo vacío ({}) para usar la página sin cuentas. */
window.PENTE_SUPABASE = { url: 'https://ymcauwmqmzsamvzwecwn.supabase.co', key: 'sb_publishable_GKXwZdz-jS4bQ7MWyO5h7A_BJZrumw3' };
