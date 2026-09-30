# pixlova-renderer (prototype)

Hôte WebView système (WebKitGTK sous Linux, WebView2 sous Windows) du moteur de rendu partagé. Prototype L00 : il sert le banc `apps/render-lab` par le protocole local `pixlova` et écrit les mesures reçues par IPC. Il ne contient ni agent, ni cache, ni credential. Statut : [ADR-005](../../docs/architecture/adr/0005-renderer-natif-webview.md) proposée.

```sh
# Linux : sudo apt-get install libwebkit2gtk-4.1-dev libgtk-3-dev (+ gstreamer1.0-libav pour H.264)
pnpm run build
cargo run -p pixlova-renderer -- --lab-dir apps/render-lab/dist --video video.mp4 \
  --query "auto&duration=60" --out resultats.json [--windowed]
```

Protocole de mesure : [QUALIFICATION-RENDU.md](../../docs/quality/QUALIFICATION-RENDU.md).
