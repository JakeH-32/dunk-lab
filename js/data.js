// Menu and radio content, mirroring the Unreal project (WBP_MainMenu, WBP_Radio).
// Clips are clips/<DunkKey><TakeoffKey>.mp4; js/clips.js lists the ones that exist.

export const TAKEOFFS = [
  { key: "OffOne", label: "One Foot", title: "ONE FOOT TAKEOFF", tip: "Run in and jump off one leg, like a layup." },
  { key: "OffTwo", label: "Two Foot", title: "TWO FOOT TAKEOFF", tip: "Run in, gather, and jump off both feet." },
  { key: "OffVert", label: "Off Vert", title: "OFF VERT", tip: "No run-up — a standing jump off both feet." },
];

export const DIFFICULTY = {
  EASY: "#3DDC84",
  MEDIUM: "#FFC53D",
  HARD: "#FF8A3D",
  EXPERT: "#FF4D6A",
};

// `only`: the takeoffs a dunk is offered for (J-Rich needs a run-up, Backflip is Off Vert only).
export const DUNKS = [
  { key: "OneHand", label: "One-Hand", difficulty: "EASY" },
  { key: "TwoHand", label: "Two-Hand", difficulty: "MEDIUM" },
  { key: "Reverse", label: "Reverse", difficulty: "MEDIUM" },
  { key: "Windmill", label: "Windmill", difficulty: "HARD" },
  { key: "Eastbay", label: "Eastbay", difficulty: "EXPERT" },
  { key: "JRich", label: "J-Rich", difficulty: "EXPERT", only: ["OffOne", "OffTwo"] },
  { key: "Backflip", label: "Backflip", difficulty: "EXPERT", only: ["OffVert"] },
];

// Presets 1-6. A preset without a song shows NO SIGNAL.
export const STATIONS = [
  { name: "DUNK FM", track: "SHOOK ONES", freq: 98.7, src: "assets/audio/DefaultTheme.mp3" },
  { name: "SLAM 104", track: "THE REAL SLIM SHADY", freq: 104.3, src: "assets/audio/Song2.mp3" },
  { name: "HANG TIME 91", track: "FAST LANE", freq: 91.5, src: "assets/audio/FastLane.mp3" },
  { name: "OVERTIME 95", track: "OVER", freq: 95.3, src: "assets/audio/Over.mp3" },
  { name: "BUCKETS 102", track: "REPRESENT", freq: 102.1, src: "assets/audio/Represent.mp3" },
];
