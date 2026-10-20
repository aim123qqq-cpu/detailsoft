import type {CSSProperties, ReactNode} from "react";
import {
  AbsoluteFill,
  CanvasImage,
  Easing,
  Sequence,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

export type ReelProps = {
  readonly eyebrow: string;
  readonly title: string;
  readonly subtitle: string;
  readonly primaryScreen: "schedule" | "intake" | "approval" | "work";
  readonly secondaryScreen: "schedule" | "intake" | "approval" | "work";
  readonly featureTitle: string;
  readonly featureBody: string;
  readonly chips: readonly [string, string, string];
};

const colors = {
  bg: "#070b10",
  line: "#293744",
  text: "#f8fafc",
  muted: "#91a0ae",
  orange: "#ff7939",
  orangeSoft: "#ff9a68",
  green: "#36c996",
};

const fontFamily =
  'Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

const clamp = {
  extrapolateLeft: "clamp" as const,
  extrapolateRight: "clamp" as const,
};

const Brand = () => (
  <div style={{display: "flex", alignItems: "center", gap: 18}}>
    <div
      style={{
        width: 54,
        height: 54,
        borderRadius: 17,
        display: "grid",
        placeItems: "center",
        color: "#111",
        background: colors.orange,
        fontSize: 34,
        fontWeight: 950,
        boxShadow: "0 12px 36px rgba(255,121,57,.28)",
      }}
    >
      +
    </div>
    <div style={{fontSize: 31, fontWeight: 850, letterSpacing: -1.1}}>
      Detail<span style={{color: colors.orange}}>Flow</span>
    </div>
  </div>
);

const Background = () => {
  const frame = useCurrentFrame();
  const {durationInFrames} = useVideoConfig();

  return (
    <AbsoluteFill style={{backgroundColor: colors.bg, overflow: "hidden"}}>
      <div
        style={{
          position: "absolute",
          width: 860,
          height: 860,
          borderRadius: "50%",
          top: -470,
          right: -420,
          opacity: 0.3,
          scale: interpolate(frame, [0, durationInFrames - 1], [1, 1.18], {
            ...clamp,
            easing: Easing.bezier(0.16, 1, 0.3, 1),
            output: "perceptual-scale",
          }),
          background:
            "radial-gradient(circle, rgba(255,121,57,.66), rgba(255,121,57,0) 70%)",
        }}
      />
      <div
        style={{
          position: "absolute",
          width: 760,
          height: 760,
          borderRadius: "50%",
          bottom: -390,
          left: -430,
          opacity: 0.18,
          translate: interpolate(
            frame,
            [0, durationInFrames - 1],
            ["0px 0px", "120px -80px"],
            {...clamp, easing: Easing.bezier(0.16, 1, 0.3, 1)},
          ),
          background:
            "radial-gradient(circle, rgba(54,201,150,.72), rgba(54,201,150,0) 70%)",
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          opacity: 0.22,
          backgroundImage:
            "linear-gradient(rgba(255,255,255,.032) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.032) 1px, transparent 1px)",
          backgroundSize: "54px 54px",
        }}
      />
    </AbsoluteFill>
  );
};

const SafeFrame = ({children, style}: {readonly children: ReactNode; readonly style?: CSSProperties}) => (
  <AbsoluteFill
    style={{
      padding: "104px 76px 128px",
      color: colors.text,
      fontFamily,
      ...style,
    }}
  >
    {children}
  </AbsoluteFill>
);

const IntroScene = ({eyebrow, title, subtitle}: Pick<ReelProps, "eyebrow" | "title" | "subtitle">) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  return (
    <SafeFrame>
      <div
        style={{
          opacity: interpolate(frame, [0, 0.55 * fps], [0, 1], {
            ...clamp,
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
          translate: interpolate(frame, [0, 0.55 * fps], ["0px 22px", "0px 0px"], {
            ...clamp,
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
        }}
      >
        <Brand />
      </div>

      <div style={{marginTop: 270}}>
        <div
          style={{
            color: colors.orangeSoft,
            fontSize: 25,
            fontWeight: 850,
            letterSpacing: 4.6,
            textTransform: "uppercase",
            opacity: interpolate(frame, [0.3 * fps, 0.85 * fps], [0, 1], clamp),
          }}
        >
          {eyebrow}
        </div>
        <div
          style={{
            marginTop: 31,
            maxWidth: 940,
            whiteSpace: "pre-line",
            fontSize: 103,
            lineHeight: 0.93,
            fontWeight: 920,
            letterSpacing: -6.2,
            opacity: interpolate(frame, [0.45 * fps, 1.1 * fps], [0, 1], {
              ...clamp,
              easing: Easing.bezier(0.16, 1, 0.3, 1),
            }),
            translate: interpolate(frame, [0.45 * fps, 1.1 * fps], ["0px 58px", "0px 0px"], {
              ...clamp,
              easing: Easing.bezier(0.16, 1, 0.3, 1),
            }),
          }}
        >
          {title}
        </div>
        <div
          style={{
            marginTop: 48,
            maxWidth: 880,
            color: colors.muted,
            fontSize: 36,
            lineHeight: 1.35,
            fontWeight: 520,
            opacity: interpolate(frame, [0.95 * fps, 1.45 * fps], [0, 1], clamp),
          }}
        >
          {subtitle}
        </div>
      </div>

      <div
        style={{
          position: "absolute",
          left: 76,
          bottom: 142,
          display: "flex",
          alignItems: "center",
          gap: 16,
          color: colors.muted,
          fontSize: 25,
          fontWeight: 700,
          opacity: interpolate(frame, [1.4 * fps, 1.8 * fps], [0, 1], clamp),
        }}
      >
        <span style={{width: 62, height: 5, borderRadius: 99, background: colors.orange}} />
        CRM для детейлинг-центра
      </div>
    </SafeFrame>
  );
};

const Phone = ({screen, side}: {readonly screen: ReelProps["primaryScreen"]; readonly side: "left" | "right"}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const enterFrom = side === "left" ? -180 : 180;

  return (
    <div
      style={{
        position: "absolute",
        width: 500,
        height: 1082,
        top: 434,
        left: side === "left" ? 25 : 555,
        padding: 12,
        borderRadius: 68,
        overflow: "hidden",
        border: "2px solid rgba(255,255,255,.16)",
        background: "#05070a",
        boxShadow: "0 42px 90px rgba(0,0,0,.55)",
        opacity: interpolate(frame, [0, 0.65 * fps], [0, 1], clamp),
        translate: interpolate(frame, [0, 0.8 * fps], [`${enterFrom}px 70px`, "0px 0px"], {
          ...clamp,
          easing: Easing.bezier(0.16, 1, 0.3, 1),
        }),
        rotate: interpolate(frame, [0, 0.8 * fps], [side === "left" ? "-7deg" : "7deg", "0deg"], {
          ...clamp,
          easing: Easing.bezier(0.16, 1, 0.3, 1),
        }),
      }}
    >
      <div
        style={{
          position: "absolute",
          zIndex: 2,
          top: 24,
          left: "50%",
          width: 132,
          height: 30,
          borderRadius: 99,
          translate: "-50% 0px",
          background: "#020305",
        }}
      />
      <CanvasImage
        name={`${screen} screen`}
        src={staticFile(`screens/${screen}.jpg`)}
        width={476}
        height={1058}
        fit="cover"
        style={{borderRadius: 56}}
      />
    </div>
  );
};

const ProductScene = ({primaryScreen, secondaryScreen, chips}: Pick<ReelProps, "primaryScreen" | "secondaryScreen" | "chips">) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  return (
    <SafeFrame>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          opacity: interpolate(frame, [0, 0.45 * fps], [0, 1], clamp),
        }}
      >
        <Brand />
        <div
          style={{
            border: `1px solid ${colors.line}`,
            borderRadius: 999,
            padding: "15px 22px",
            color: colors.green,
            background: "rgba(54,201,150,.08)",
            fontSize: 22,
            fontWeight: 820,
          }}
        >
          ● Рабочий процесс
        </div>
      </div>

      <Phone screen={primaryScreen} side="left" />
      <Phone screen={secondaryScreen} side="right" />

      <div
        style={{
          position: "absolute",
          left: 76,
          right: 76,
          bottom: 116,
          display: "flex",
          gap: 13,
          justifyContent: "center",
        }}
      >
        {chips.map((chip, index) => (
          <div
            key={chip}
            style={{
              flex: 1,
              padding: "19px 18px",
              borderRadius: 20,
              border: `1px solid ${index === 1 ? "rgba(255,121,57,.56)" : colors.line}`,
              color: index === 1 ? colors.orangeSoft : colors.muted,
              background: index === 1 ? "rgba(255,121,57,.11)" : "rgba(17,24,33,.84)",
              textAlign: "center",
              fontSize: 22,
              fontWeight: 820,
              opacity: interpolate(frame, [(1 + index * 0.15) * fps, (1.45 + index * 0.15) * fps], [0, 1], clamp),
              translate: interpolate(frame, [(1 + index * 0.15) * fps, (1.45 + index * 0.15) * fps], ["0px 26px", "0px 0px"], {
                ...clamp,
                easing: Easing.bezier(0.16, 1, 0.3, 1),
              }),
            }}
          >
            {chip}
          </div>
        ))}
      </div>
    </SafeFrame>
  );
};

const ClosingScene = ({featureTitle, featureBody}: Pick<ReelProps, "featureTitle" | "featureBody">) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  return (
    <SafeFrame style={{justifyContent: "center"}}>
      <div
        style={{
          width: 124,
          height: 10,
          marginBottom: 56,
          borderRadius: 99,
          background: colors.orange,
          scale: interpolate(frame, [0, 0.55 * fps], [0, 1], {
            ...clamp,
            easing: Easing.spring({damping: 200}),
            output: "perceptual-scale",
          }),
          transformOrigin: "left center",
        }}
      />
      <div
        style={{
          maxWidth: 940,
          fontSize: 98,
          lineHeight: 0.96,
          fontWeight: 920,
          letterSpacing: -5.6,
          opacity: interpolate(frame, [0.15 * fps, 0.8 * fps], [0, 1], clamp),
          translate: interpolate(frame, [0.15 * fps, 0.8 * fps], ["0px 54px", "0px 0px"], {
            ...clamp,
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
        }}
      >
        {featureTitle}
      </div>
      <div
        style={{
          marginTop: 42,
          maxWidth: 900,
          color: colors.muted,
          fontSize: 37,
          lineHeight: 1.38,
          opacity: interpolate(frame, [0.75 * fps, 1.25 * fps], [0, 1], clamp),
        }}
      >
        {featureBody}
      </div>
      <div
        style={{
          marginTop: 100,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "30px 34px",
          borderRadius: 27,
          border: "1px solid rgba(255,121,57,.42)",
          background: "linear-gradient(120deg, rgba(255,121,57,.19), rgba(255,121,57,.06))",
          opacity: interpolate(frame, [1.15 * fps, 1.65 * fps], [0, 1], clamp),
          translate: interpolate(frame, [1.15 * fps, 1.65 * fps], ["0px 28px", "0px 0px"], {
            ...clamp,
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
        }}
      >
        <div>
          <div style={{fontSize: 24, color: colors.orangeSoft, fontWeight: 820, letterSpacing: 2.5}}>
            ПОПРОБУЙТЕ В РАБОТЕ
          </div>
          <div style={{marginTop: 8, fontSize: 34, fontWeight: 840}}>DetailFlow</div>
        </div>
        <div
          style={{
            width: 78,
            height: 78,
            borderRadius: 24,
            display: "grid",
            placeItems: "center",
            color: "#111",
            background: colors.orange,
            fontSize: 42,
            fontWeight: 900,
          }}
        >
          →
        </div>
      </div>
    </SafeFrame>
  );
};

export const ProductReel = (props: ReelProps) => {
  const frame = useCurrentFrame();
  const {fps, durationInFrames} = useVideoConfig();
  const scene = 4 * fps;

  return (
    <AbsoluteFill
      style={{
        backgroundColor: colors.bg
      }}
    >
      <Background />
      <Sequence name="Hook" durationInFrames={scene} premountFor={fps}>
        <IntroScene eyebrow={props.eyebrow} title={props.title} subtitle={props.subtitle} />
      </Sequence>
      <Sequence name="Product" from={scene - 10} durationInFrames={scene + 20} premountFor={fps}>
        <ProductScene
          primaryScreen={props.primaryScreen}
          secondaryScreen={props.secondaryScreen}
          chips={props.chips}
        />
      </Sequence>
      <Sequence name="Call-to-action" from={scene * 2} durationInFrames={scene} premountFor={fps}>
        <ClosingScene featureTitle={props.featureTitle} featureBody={props.featureBody} />
      </Sequence>

      <div
        style={{
          position: "absolute",
          zIndex: 20,
          left: 0,
          bottom: 0,
          width: `${interpolate(frame, [0, durationInFrames - 1], [0, 100], clamp)}%`,
          height: 7,
          background: colors.orange,
          boxShadow: "0 0 28px rgba(255,121,57,.7)",
        }}
      />
    </AbsoluteFill>
  );
};
