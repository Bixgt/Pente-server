# Servidor de Pente

Árbitro de las partidas online. Guarda cada sala en memoria y valida **cada jugada** con el mismo núcleo de reglas que usa el juego (`pente-core.js`, copia exacta de `src/core/pente.js`; `python3 build.py` la regenera). El cliente nunca decide nada.

## Qué hace
- Salas con código de 5 letras/números (sin I, O, 0, 1). El que crea es el jugador 1; en la revancha los lados se intercambian.
- Reconexión: cada jugador recibe un token secreto y puede volver a su lugar si se cae.
- Si un jugador queda desconectado 60 s, el rival puede **reclamar la victoria**. También se puede **abandonar**.
- Límites: mensajes de 2 KB, 12 mensajes por segundo por conexión, 500 salas, salas inactivas se borran a las 2 h.
- `GET /health` responde `{"ok":true}`: sirve para despertar al servidor cuando el plan gratuito lo durmió.

## Qué NO hace (todavía)
Cuentas, ranking, historial, torneos, espectadores, reloj de partida. Todo vive **en memoria**: si el servidor se reinicia o se duerme mucho tiempo, las salas se pierden. Para guardar datos hace falta una base de datos (otra decisión).

## Probarlo en tu compu
```
npm install
npm start          # escucha en el puerto 8787 (o el de la variable PORT)
npm test           # 23 tests con clientes simulados
```

## Publicarlo (Render, plan gratuito)
Los menús de Render pueden cambiar: verificá cada paso en su pantalla.
1. Subir el contenido de esta carpeta a un repositorio de GitHub (por ejemplo `pente-server`).
2. En Render: *New → Web Service* y conectar ese repositorio.
3. Build Command: `npm install` · Start Command: `npm start` · Plan: *Free*.
4. Variable de entorno (opcional, recomendada): `ALLOWED_ORIGINS` = `https://TU-USUARIO.github.io` para que solo tu juego pueda conectarse.
5. Cuando termine, Render muestra la dirección `https://algo.onrender.com`. En el juego, editar `config.js` y poner `window.PENTE_SERVER = 'wss://algo.onrender.com';` (con **wss**, no https).

Plan gratuito: se duerme tras 15 minutos sin uso y tarda cerca de un minuto en despertar. El juego manda un aviso a `/health` apenas se abre para adelantar ese despertar.
