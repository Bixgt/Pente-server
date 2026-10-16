# Servidor de Pente

Árbitro de las partidas online. Guarda cada sala en memoria y valida **cada jugada** con el mismo núcleo de reglas que usa el juego (`pente-core.js`, copia exacta de `src/core/pente.js`; `python3 build.py` la regenera). El cliente nunca decide nada.

## v56
- El ranking del desafío incluye a quien empezó y no terminó (`playing`), y la racha del XP cuenta esos días.

## v55
- XP verificado: `pente-xp.js` (nuevo, copia de `src/xp.js`), `grant_xp` en Supabase (`supabase/xp.sql`). Se da al terminar el desafío diario y al terminar una partida online entre dos cuentas verificadas (tope 10 por día). El ranking del desafío incluye el XP de cada persona.

## Qué hace
- Salas con código de 5 letras/números (sin I, O, 0, 1). El que crea es el jugador 1; en la revancha los lados se intercambian.
- Reconexión: cada jugador recibe un token secreto y puede volver a su lugar si se cae.
- Si un jugador queda desconectado 60 s, el rival puede **reclamar la victoria**. También se puede **abandonar**.
- Límites: mensajes de 2 KB, 12 mensajes por segundo por conexión, 500 salas, salas inactivas se borran a las 2 h.
- **Salas públicas y espectadores:** `create` acepta `public:true` (por defecto privada). `list` devuelve las públicas con alguien conectado (máx. 50); `spectate {code}` permite mirar una sala pública que ya tiene dos jugadores (máx. 20 espectadores; las privadas devuelven `PRIVATE_ROOM`). Los espectadores reciben jugadas, final y revancha, y no pueden jugar, rendirse ni pedir revancha (`NOT_A_PLAYER`).
- **Chat:** `{t:'chat', text}` lo reciben jugadores y espectadores (`{t:'chat', id, name, seat, text, n}`); máx. 200 caracteres, 1 mensaje cada 0,7 s (`CHAT_RATE`), historial de 50 mensajes (`chatlog`) para quien entra o reconecta. Sin moderación: el silenciado es del lado del cliente.
- **Reloj:** `create` acepta `timer` (por defecto `true`): 10 min en total por jugador y 1 min por jugada; si se acaba cualquiera, el servidor manda `over` con `reason:'timeout'`. Arranca al entrar el segundo jugador y en cada revancha; `sync`, `move` y `over` traen `clock {on,total,turnMs,rem,current,turnLeft}` (valores en vivo al enviar). Configurable con `createPenteServer({totalMs, turnMs})`.
- **Variantes y blitz:** `create` acepta `variant` (`classic`, `pairs3`, `triples`, `gomoku`) y `blitz:true` (3 min por jugador en total, sin tiempo por jugada, `clock.turnMs = 0`). Las partidas de variantes o blitz no registran estadísticas.
- **Desafío diario:** `{t:'dailyInfo', jwt}` (ver el del día; sin cuenta responde `needAccount`), `{t:'dailyStart', jwt}` (empieza o retoma; responde `daily` con `status` new/playing/done, la posición `setup`, las `moves` y `elapsed`), `{t:'dailyMove', x, y}` (responde `dailyMove` con la jugada de la máquina `ai` y, al terminar, `result` con jugadas/tiempo) y `{t:'dailyResign'}`. Requiere cuenta verificada; el tiempo corre desde la primera ficha. Usa `pente-daily.js` (copia de `src/daily.js`). `{t:'dailyBoard', jwt}` devuelve el ranking del día y de la semana (`today`/`week`, con `me` en tu fila). Con Supabase (`supabase/daily.sql`) guarda el intento y las jugadas; sin Supabase vive en memoria.
- **Bots (salas de 4):** `{t:'bot', level, seat?}` suma un bot en un asiento libre y `{t:'botoff', seat}` lo saca, solo antes de empezar. Los bots juegan desde el servidor con `pente-ai.js` (copia de `src/ai.js`; `python3 build.py` la regenera), aceptan siempre la revancha y no cuentan como personas conectadas.
- **Todos contra todos:** `create` con `players:4, ffa:true`. Cada asiento es su propio color; abandonar, quedarse sin tiempo o `claimWin` (con ausentes ≥ 60 s) **eliminan** al asiento (`{t:'out', seat, reason, at, clock}`); el último en pie gana (`over.reason = 'last'`, `over.winner` = asiento). `sync.outs` lleva las eliminaciones `[jugadasHechas, asiento]` para reconstruir la partida.
- `GET /health` responde `{"ok":true}`: sirve para despertar al servidor cuando el plan gratuito lo durmió.

## Qué NO hace (todavía)
Ranking, torneos compartidos. Las salas viven **en memoria**: si el servidor se reinicia o se duerme mucho tiempo, las salas se pierden. Para guardar datos hace falta una base de datos (otra decisión).

## Probarlo en tu compu
```
npm install
npm start          # escucha en el puerto 8787 (o el de la variable PORT)
npm test           # 34 tests con clientes simulados
```

## Publicarlo (Render, plan gratuito)
Los menús de Render pueden cambiar: verificá cada paso en su pantalla.
1. Subir el contenido de esta carpeta a un repositorio de GitHub (por ejemplo `pente-server`).
2. En Render: *New → Web Service* y conectar ese repositorio.
3. Build Command: `npm install` · Start Command: `npm start` · Plan: *Free*.
4. Variable de entorno (opcional, recomendada): `ALLOWED_ORIGINS` = `https://TU-USUARIO.github.io` para que solo tu juego pueda conectarse.
5. Cuando termine, Render muestra la dirección `https://algo.onrender.com`. En el juego, editar `config.js` y poner `window.PENTE_SERVER = 'wss://algo.onrender.com';` (con **wss**, no https).

Plan gratuito: se duerme tras 15 minutos sin uso y tarda cerca de un minuto en despertar. El juego manda un aviso a `/health` apenas se abre para adelantar ese despertar.

## Estadísticas verificadas (v32, opcional pero recomendado)
El servidor puede registrar las partidas entre **dos cuentas** en Supabase, para que las estadísticas online no se puedan falsear desde el navegador.
1. Correr `supabase/online.sql` en Supabase (SQL Editor).
2. En Render → tu servicio → *Environment*, agregar:
   - `SUPABASE_URL` = `https://ymcauwmqmzsamvzwecwn.supabase.co`
   - `SUPABASE_ANON_KEY` = la clave **publishable** (la misma que usa el juego)
   - `SUPABASE_SERVICE_KEY` = la clave **secret** (Supabase → Project Settings → API Keys). **Es secreta: solo en Render, nunca en GitHub ni en el juego.**
3. Redeploy. Sin estas variables el servidor funciona igual, pero no registra nada.

Reglas: cuentan solo partidas entre dos cuentas distintas con sesión iniciada, con al menos 10 jugadas, máximo 10 por pareja cada 24 horas. Las partidas con invitados no suman.

## Entrar con nombre + contraseña (v33)
Usa las mismas 3 variables de arriba, más correr `supabase/password.sql`. Endpoint: `POST /login` con `{name, password}` → sesión de Supabase (o 401 con el mismo error para nombre/contraseña malos, 429 si hay demasiados intentos, 503 si falta configurar). Respeta `ALLOWED_ORIGINS`.

## v60
- `playedDays(uid)`: historial de ~45 días del usuario, enviado como `played` en `daily` info/start para sincronizar la racha entre aparatos.
