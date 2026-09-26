# Flash Contatore

Web app installabile (PWA) che usa il flash del telefono per inviare sequenze di impulsi al sensore ottico di scroll del contatore MT880, così da scorrere automaticamente fino a un parametro (es. 1.8.0).

Tempi del sensore (come il tasto Avanti): breve < 2 s, lunga 2–5 s, estesa ≥ 5 s.

- Funziona con Chrome su Android; richiede HTTPS (GitHub Pages va bene).
- Le sequenze si modificano dall'app e restano salvate sul telefono.
- Nessuna build: file statici (`index.html`, `app.js`, `style.css`, `sw.js`).

Test in locale: `python3 -m http.server` e apri `http://localhost:8000` (il flash però richiede il telefono in HTTPS).
