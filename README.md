# Servidor de Pente

Árbitro de las partidas online. Guarda cada sala en memoria y valida **cada jugada** con el mismo núcleo de reglas que usa el juego (`pente-core.js`, copia exacta de `src/core/pente.js`; `python3 build.py` la regenera). El cliente nunca decide nada.

## Qué hace
- Salas con código de 5 letras/números (sin I, O, 0, 1). El que crea es el jugador 1; en la revancha los lados se intercambian.
- Reconexión: cada jugador recibe un token secreto y puede volver a su lugar si se cae.
- Si un jugador queda desconectado 60 s, el rival puede **reclamar la victoria**. También se puede **abandonar**.
- Límites: mensajes de 2 KB, 12 mensajes por segundo por conexión, 500 salas, salas inactivas se borran a las 2 h.
- **Salas públicas y espectadores:** `create` acepta `public:true` (por defecto privada). `list` devuelve las públicas con alguien conectado (máx. 50); `spectate {code}` permite mirar una sala pública que ya tiene dos jugadores (máx. 20 espectadores; las privadas devuelven `PRIVATE_ROOM`). Los espectadores reciben jugadas, final y revancha, y no pueden jugar, rendirse ni pedir revancha (`NOT_A_PLAYER`).
- **Chat:** `{t:'chat', text}` lo reciben jugadores y espectadores (`{t:'chat', id, name, seat, text, n}`); máx. 200 caracteres, 1 mensaje cada 0,7 s (`CHAT_RATE`), historial de 50 mensajes (`chatlog`) para quien entra o reconecta. Sin moderación: el silenciado es del lado del cliente.
- `GET /health` responde `{"ok":true}`: sirve para despertar al servidor cuando el plan gratuito lo durmió.

## Qué NO hace (todavía)
Cuentas, ranking, historial, torneos, reloj de partida. Todo vive **en memoria**: si el servidor se reinicia o se duerme mucho tiempo, las salas se pierden. Para guardar datos hace falta una base de datos (otra decisión).

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
