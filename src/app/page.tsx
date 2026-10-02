'use client';

import * as React from 'react';
import {
  Eraser,
  ImagePlus,
  RotateCcw,
  Scan,
  Sparkles,
  TriangleAlert,
  Upload,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { SliderControl } from '@/components/watermark/slider-control';
import { ThemeToggle } from '@/components/watermark/theme';
import {
  cleanFrame,
  detectWatermarkCandidate,
  getAdaptiveImagePreset,
  getWatermarkInfo,
  grabImageFrame,
  loadReferenceImages,
  type CleanerSettings,
  type DetectedWatermark,
  type WmRect,
} from '@/lib/watermark/engine';

interface Frame {
  width: number;
  height: number;
  imageData: ImageData;
}

const DEFAULT_SETTINGS: CleanerSettings = { gain: 0.6, offsetX: -128, offsetY: -128, sizeScale: 1 };
const DEFAULT_POS_RANGE = { xMin: -250, xMax: 150, yMin: -250, yMax: 150 };

type PresetKey = 'new' | 'classic';

const PRESETS: { key: PresetKey; label: string }[] = [
  { key: 'new', label: 'Gemini / Nano Banana' },
  { key: 'classic', label: 'Classic Corner' },
];

function drawBoxOutline(
  ctx: CanvasRenderingContext2D,
  box: WmRect,
  color: string,
  offsetX = 0,
  offsetY = 0,
  scaleX = 1,
  scaleY = 1,
) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.strokeRect(
    (box.x - offsetX) * scaleX,
    (box.y - offsetY) * scaleY,
    box.width * scaleX,
    box.height * scaleY,
  );
  ctx.restore();
}

export default function Home() {
  const { toast } = useToast();

  const [fileName, setFileName] = React.useState<string | null>(null);
  const [frame, setFrame] = React.useState<Frame | null>(null);
  const [settings, setSettings] = React.useState<CleanerSettings>(DEFAULT_SETTINGS);
  const [posRange, setPosRange] = React.useState(DEFAULT_POS_RANGE);
  const [detected, setDetected] = React.useState<DetectedWatermark | null>(null);
  const [activePreset, setActivePreset] = React.useState<PresetKey>('new');
  const [isProcessing, setIsProcessing] = React.useState(false);
  const [isExporting, setIsExporting] = React.useState(false);
  const [isDragging, setIsDragging] = React.useState(false);

  const bg96Ref = React.useRef<HTMLImageElement | null>(null);
  const originalBitmapRef = React.useRef<ImageBitmap | null>(null);
  const baseRef = React.useRef<(WmRect & { size: number }) | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const mainCanvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const zoomOrigRef = React.useRef<HTMLCanvasElement | null>(null);
  const zoomCleanRef = React.useRef<HTMLCanvasElement | null>(null);
  const rafRef = React.useRef<number | null>(null);

  const ensureEngine = React.useCallback(async () => {
    if (!bg96Ref.current) {
      const { bg96 } = await loadReferenceImages();
      bg96Ref.current = bg96;
    }
    return bg96Ref.current;
  }, []);

  // ── Live tuner rendering (rAF-batched) ──
  const renderTuner = React.useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const f = frame;
      const bg96 = bg96Ref.current;
      const base = baseRef.current;
      if (!f || !bg96 || !base) return;

      const { width, height, imageData } = f;
      const copy = new ImageData(new Uint8ClampedArray(imageData.data), width, height);
      const { wm, roi } = cleanFrame(bg96, copy, width, height, base, settings);

      const offscreen = document.createElement('canvas');
      offscreen.width = width;
      offscreen.height = height;
      offscreen.getContext('2d')?.putImageData(copy, 0, 0);

      // Full-frame preview
      const mainCanvas = mainCanvasRef.current;
      if (mainCanvas) {
        const fit = 760;
        const scale = Math.min(1, fit / width, fit / height);
        mainCanvas.width = Math.max(1, Math.round(width * scale));
        mainCanvas.height = Math.max(1, Math.round(height * scale));
        const mctx = mainCanvas.getContext('2d');
        if (mctx) {
          mctx.clearRect(0, 0, mainCanvas.width, mainCanvas.height);
          mctx.imageSmoothingEnabled = true;
          mctx.imageSmoothingQuality = 'high';
          mctx.drawImage(offscreen, 0, 0, mainCanvas.width, mainCanvas.height);
          drawBoxOutline(mctx, wm, 'rgba(16, 185, 129, 0.95)');
        }
      }

      // Zoomed original vs cleaned (pixel-exact)
      const zoomSize = 200;
      const zoomOrig = zoomOrigRef.current;
      if (zoomOrig && originalBitmapRef.current) {
        zoomOrig.width = zoomSize;
        zoomOrig.height = zoomSize;
        const zctx = zoomOrig.getContext('2d');
        if (zctx) {
          zctx.imageSmoothingEnabled = false;
          zctx.clearRect(0, 0, zoomSize, zoomSize);
          zctx.drawImage(originalBitmapRef.current, roi.x, roi.y, roi.width, roi.height, 0, 0, zoomSize, zoomSize);
          drawBoxOutline(
            zctx, wm, 'rgba(245, 158, 11, 0.9)',
            roi.x, roi.y, zoomSize / roi.width, zoomSize / roi.height,
          );
        }
      }

      const zoomClean = zoomCleanRef.current;
      if (zoomClean) {
        zoomClean.width = zoomSize;
        zoomClean.height = zoomSize;
        const zctx = zoomClean.getContext('2d');
        if (zctx) {
          zctx.imageSmoothingEnabled = false;
          zctx.clearRect(0, 0, zoomSize, zoomSize);
          zctx.drawImage(offscreen, roi.x, roi.y, roi.width, roi.height, 0, 0, zoomSize, zoomSize);
          drawBoxOutline(
            zctx, wm, 'rgba(16, 185, 129, 0.95)',
            roi.x, roi.y, zoomSize / roi.width, zoomSize / roi.height,
          );
        }
      }
    });
  }, [frame, settings]);

  React.useEffect(() => {
    if (frame) renderTuner();
  }, [frame, settings, renderTuner]);

  const applyAutoSettings = React.useCallback(
    (f: Frame, det: DetectedWatermark | null) => {
      const p = det
        ? {
            gain: det.gain,
            offsetX: det.offsetX,
            offsetY: det.offsetY,
            sizeScale: det.sizeScale,
          }
        : getAdaptiveImagePreset('new', f.width, f.height);
      setSettings(p);
      setActivePreset(det ? det.presetKey : 'new');
      setPosRange({
        xMin: -Math.round(f.width * 0.45),
        xMax: Math.round(f.width * 0.2),
        yMin: -Math.round(f.height * 0.45),
        yMax: Math.round(f.height * 0.2),
      });
    },
    [],
  );

  const handleFile = React.useCallback(
    async (file: File) => {
      if (!file.type.startsWith('image/')) {
        toast({
          title: 'Unsupported file',
          description: 'Please choose a PNG, JPG or WebP image.',
          variant: 'destructive',
        });
        return;
      }
      setIsProcessing(true);
      try {
        const bg96 = await ensureEngine();
        const f = await grabImageFrame(file);
        const base = getWatermarkInfo(f.width, f.height) as WmRect & { size: number };
        baseRef.current = base;

        if (originalBitmapRef.current) originalBitmapRef.current.close();
        originalBitmapRef.current = await createImageBitmap(f.imageData);

        const det = detectWatermarkCandidate(f.imageData, f.width, f.height, bg96);
        setDetected(det);
        setFileName(file.name);
        setFrame(f);
        applyAutoSettings(f, det);
      } catch (err) {
        console.error(err);
        toast({
          title: 'Could not process image',
          description: err instanceof Error ? err.message : 'Unknown error',
          variant: 'destructive',
        });
      } finally {
        setIsProcessing(false);
      }
    },
    [applyAutoSettings, ensureEngine, toast],
  );

  const handleResetSliders = () => {
    if (!frame) return;
    applyAutoSettings(frame, detected);
    toast({ title: 'Sliders reset', description: 'Back to the detected / adaptive values.' });
  };

  const handlePreset = (key: PresetKey) => {
    if (!frame) return;
    setSettings(getAdaptiveImagePreset(key, frame.width, frame.height));
    setActivePreset(key);
  };

  const handleExport = async () => {
    const f = frame;
    const bg96 = bg96Ref.current;
    const base = baseRef.current;
    if (!f || !bg96 || !base || isExporting) return;

    setIsExporting(true);
    try {
      const copy = new ImageData(new Uint8ClampedArray(f.imageData.data), f.width, f.height);
      cleanFrame(bg96, copy, f.width, f.height, base, settings);

      const canvas = document.createElement('canvas');
      canvas.width = f.width;
      canvas.height = f.height;
      canvas.getContext('2d')?.putImageData(copy, 0, 0);

      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
      if (!blob) throw new Error('PNG encoding failed');

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `clean_${fileName ?? 'image.png'}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      toast({ title: 'Image exported', description: `${f.width}×${f.height} PNG saved.` });
    } catch (err) {
      console.error(err);
      toast({
        title: 'Export failed',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setIsExporting(false);
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (isProcessing) return;
    const file = e.dataTransfer.files?.[0];
    if (file) void handleFile(file);
  };

  const openFilePicker = () => {
    if (!isProcessing) fileInputRef.current?.click();
  };

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      {/* Compact header — no banner, no marketing copy */}
      <header className="sticky top-0 z-20 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-12 w-full max-w-6xl items-center justify-between gap-3 px-4">
          <div className="flex items-center gap-2.5">
            <span className="flex size-7 items-center justify-center rounded-md bg-emerald-500/15 text-emerald-500">
              <Eraser className="size-4" aria-hidden />
            </span>
            <h1 className="text-sm leading-none">
              <span className="font-semibold tracking-tight">Openmukti</span>{' '}
              <span className="text-muted-foreground">Gemini Watermark Remover</span>
            </h1>
          </div>
          <div className="flex items-center gap-1">
            <Badge variant="outline" className="hidden gap-1 border-emerald-500/30 font-normal text-emerald-600 sm:inline-flex dark:text-emerald-400">
              <Sparkles className="size-3" aria-hidden />
              Local
            </Badge>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-5">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFile(file);
            e.target.value = '';
          }}
        />

        {!frame ? (
          /* ── Dropzone ── */
          <div className="flex h-[calc(100vh-7.5rem)] min-h-[380px] items-center justify-center">
            <div
              role="button"
              tabIndex={0}
              aria-label="Upload image"
              onClick={openFilePicker}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  openFilePicker();
                }
              }}
              onDragOver={(e) => {
                e.preventDefault();
                if (!isProcessing) setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={onDrop}
              className={cn(
                'group flex w-full max-w-xl cursor-pointer flex-col items-center justify-center gap-4 rounded-2xl border-2 border-dashed p-10 text-center transition-colors',
                isDragging
                  ? 'border-emerald-500 bg-emerald-500/5'
                  : 'border-border hover:border-muted-foreground/40 hover:bg-muted/40',
                isProcessing && 'pointer-events-none opacity-70',
              )}
            >
              <span
                className={cn(
                  'flex size-14 items-center justify-center rounded-full bg-muted transition-colors',
                  isDragging ? 'text-emerald-500' : 'text-muted-foreground group-hover:text-foreground',
                )}
              >
                {isProcessing ? (
                  <span className="size-5 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />
                ) : (
                  <ImagePlus className="size-6" aria-hidden />
                )}
              </span>
              <div className="space-y-1">
                <p className="font-medium">
                  {isProcessing ? 'Analyzing watermark…' : 'Drop your Gemini image here'}
                </p>
                <p className="text-sm text-muted-foreground">or click to browse · PNG · JPG · WebP</p>
              </div>
            </div>
          </div>
        ) : (
          /* ── Workbench ── */
          <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_330px]">
            {/* Preview column */}
            <div className="flex min-w-0 flex-col gap-4">
              <section className="rounded-xl border bg-card" aria-label="Preview">
                <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
                  <span className="text-[13px] font-medium">Preview</span>
                  <Badge variant="secondary" className="font-mono text-[11px] font-normal">
                    {frame.width}×{frame.height}
                  </Badge>
                  {detected && (
                    <Badge
                      variant="outline"
                      className={cn(
                        'gap-1 text-[11px] font-normal',
                        detected.matchFound
                          ? 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400'
                          : 'border-amber-500/40 text-amber-600 dark:text-amber-400',
                      )}
                    >
                      {detected.matchFound ? (
                        <Scan className="size-3" aria-hidden />
                      ) : (
                        <TriangleAlert className="size-3" aria-hidden />
                      )}
                      {detected.matchFound
                        ? `${detected.name} · ${Math.round(detected.score * 100)}%`
                        : `Preset · ${detected.name}`}
                    </Badge>
                  )}
                  <span className="grow" />
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1.5 px-2.5 text-[12px]"
                    onClick={openFilePicker}
                    disabled={isProcessing}
                  >
                    <Upload className="size-3.5" aria-hidden />
                    Replace
                  </Button>
                </div>
                <div className="flex items-center justify-center p-3">
                  <canvas
                    ref={mainCanvasRef}
                    className="max-h-[56vh] w-auto max-w-full rounded-md bg-[repeating-conic-gradient(#8881_0%_25%,transparent_0%_50%)] bg-[length:16px_16px]"
                    aria-label="Cleaned preview with watermark region outlined"
                  />
                </div>
              </section>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <section className="rounded-xl border bg-card" aria-label="Zoomed original">
                  <div className="border-b px-3 py-2 text-[13px] font-medium">
                    Zoomed original
                  </div>
                  <div className="flex items-center justify-center p-3">
                    <canvas
                      ref={zoomOrigRef}
                      className="aspect-square w-full max-w-[220px] rounded-md bg-muted/50"
                      aria-label="Zoomed original watermark region"
                    />
                  </div>
                </section>
                <section className="rounded-xl border bg-card" aria-label="Zoomed cleaned">
                  <div className="flex items-center gap-1.5 border-b px-3 py-2 text-[13px] font-medium">
                    <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden />
                    Zoomed cleaned
                  </div>
                  <div className="flex items-center justify-center p-3">
                    <canvas
                      ref={zoomCleanRef}
                      className="aspect-square w-full max-w-[220px] rounded-md bg-muted/50"
                      aria-label="Zoomed cleaned watermark region"
                    />
                  </div>
                </section>
              </div>
            </div>

            {/* Controls column */}
            <aside className="rounded-xl border bg-card lg:sticky lg:top-16" aria-label="Adjustments">
              <div className="border-b px-4 py-3 text-[13px] font-medium">Adjustments</div>
              <div className="space-y-5 p-4">
                <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1" role="group" aria-label="Model preset">
                  {PRESETS.map((p) => (
                    <button
                      key={p.key}
                      type="button"
                      onClick={() => handlePreset(p.key)}
                      aria-pressed={activePreset === p.key}
                      className={cn(
                        'rounded-md px-2 py-1.5 text-[12px] font-medium transition-colors',
                        activePreset === p.key
                          ? 'bg-background shadow-sm'
                          : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>

                <SliderControl
                  label="Strength (Gain)"
                  value={settings.gain}
                  min={0.1}
                  max={3}
                  sliderStep={0.01}
                  inputStep={0.001}
                  suffix="x"
                  onChange={(v) => setSettings((s) => ({ ...s, gain: v }))}
                />
                <SliderControl
                  label="Size Scale"
                  value={settings.sizeScale}
                  min={0.5}
                  max={2}
                  sliderStep={0.01}
                  inputStep={0.001}
                  suffix="x"
                  onChange={(v) => setSettings((s) => ({ ...s, sizeScale: v }))}
                />
                <SliderControl
                  label="Position X"
                  value={settings.offsetX}
                  min={posRange.xMin}
                  max={posRange.xMax}
                  sliderStep={1}
                  inputStep={0.001}
                  suffix="px"
                  onChange={(v) => setSettings((s) => ({ ...s, offsetX: v }))}
                />
                <SliderControl
                  label="Position Y"
                  value={settings.offsetY}
                  min={posRange.yMin}
                  max={posRange.yMax}
                  sliderStep={1}
                  inputStep={0.001}
                  suffix="px"
                  onChange={(v) => setSettings((s) => ({ ...s, offsetY: v }))}
                />

                <Separator />

                <div className="grid gap-2">
                  <Button
                    variant="outline"
                    onClick={handleResetSliders}
                    disabled={!frame}
                    className="gap-2"
                  >
                    <RotateCcw className="size-4" aria-hidden />
                    Reset Sliders
                  </Button>
                  <Button
                    onClick={handleExport}
                    disabled={isExporting}
                    className="gap-2 bg-emerald-600 text-white hover:bg-emerald-600/90"
                  >
                    {isExporting ? (
                      <span className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />
                    ) : (
                      <Eraser className="size-4" aria-hidden />
                    )}
                    {isExporting ? 'Exporting…' : 'Export Image'}
                  </Button>
                </div>
              </div>
            </aside>
          </div>
        )}
      </main>

      <footer className="mt-auto border-t">
        <div className="mx-auto flex h-10 w-full max-w-6xl items-center justify-center px-4">
          <p className="text-[11px] text-muted-foreground">Openmukti</p>
        </div>
      </footer>
    </div>
  );
}
