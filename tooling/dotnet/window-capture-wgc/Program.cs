using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using Vortice.Direct3D;
using Vortice.Direct3D11;
using Vortice.DXGI;
using Windows.Foundation;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;
using Windows.Graphics.Imaging;
using Windows.Storage.Streams;
using WinRT;
using static Vortice.Direct3D11.D3D11;

[ComImport]
[Guid("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IGraphicsCaptureItemInterop
{
    IntPtr CreateForWindow(IntPtr window, in Guid iid);
    IntPtr CreateForMonitor(IntPtr monitor, in Guid iid);
}

internal static class Program
{
    [DllImport("d3d11.dll", ExactSpelling = true)]
    private static extern uint CreateDirect3D11DeviceFromDXGIDevice(
        IntPtr dxgiDevice,
        out IntPtr graphicsDevice);

    private static readonly Guid GraphicsCaptureItemGuid =
        new("79C3F95B-31F7-4EC2-A464-632EF5D30760");

    private sealed record ScreenRect(int Left, int Top, int Right, int Bottom)
    {
        public int Width => Right - Left;
        public int Height => Bottom - Top;
    }

    private sealed record CaptureOptions(
        long Handle,
        string OutputPath,
        string Format,
        int TimeoutMs,
        bool IncludeCursor,
        ScreenRect? WindowRect,
        ScreenRect? ClientRect);

    public static async Task<int> Main(string[] args)
    {
        try
        {
            var options = ParseArgsOrThrow(args);
            var result = await CaptureWindowAsync(options);
            Console.WriteLine(JsonSerializer.Serialize(result));
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.Message);
            return 1;
        }
    }

    private static CaptureOptions ParseArgsOrThrow(string[] args)
    {
        var handle = ParseHandle(ReadRequiredArg(args, "--handle"));
        var outputPath = ReadRequiredArg(args, "--out");
        var format = ReadOptionalArg(args, "--format")?.ToLowerInvariant() ?? "png";
        if (format is not ("png" or "jpg" or "jpeg"))
        {
            throw new InvalidOperationException(
                $"--format must be png or jpg, got \"{format}\".");
        }

        var timeoutMs = ParsePositiveInt(ReadOptionalArg(args, "--timeout-ms"), 5000, "--timeout-ms");
        var includeCursor = args.Contains("--include-cursor", StringComparer.OrdinalIgnoreCase);
        var windowRect = ParseOptionalScreenRect(args, "window");
        var clientRect = ParseOptionalScreenRect(args, "client");

        return new CaptureOptions(
            Handle: handle,
            OutputPath: Path.GetFullPath(outputPath),
            Format: format is "jpeg" ? "jpg" : format,
            TimeoutMs: timeoutMs,
            IncludeCursor: includeCursor,
            WindowRect: windowRect,
            ClientRect: clientRect);
    }

    private static async Task<object> CaptureWindowAsync(CaptureOptions options)
    {
        if (!GraphicsCaptureSession.IsSupported())
        {
            throw new InvalidOperationException(
                "Windows.Graphics.Capture is not supported on this machine.");
        }

        var hwnd = new IntPtr(options.Handle);
        if (hwnd == IntPtr.Zero)
        {
            throw new InvalidOperationException("The requested window handle is invalid.");
        }

        Directory.CreateDirectory(Path.GetDirectoryName(options.OutputPath) ?? options.OutputPath);

        using var d3dDevice = D3D11CreateDevice(
            DriverType.Hardware,
            DeviceCreationFlags.BgraSupport,
            Array.Empty<FeatureLevel>());
        using var dxgiDevice = d3dDevice.QueryInterface<IDXGIDevice>();

        var interopStatus = CreateDirect3D11DeviceFromDXGIDevice(
            dxgiDevice.NativePointer,
            out var graphicsDevicePointer);
        if (interopStatus != 0)
        {
            throw new InvalidOperationException(
                $"CreateDirect3D11DeviceFromDXGIDevice failed with HRESULT 0x{interopStatus:X8}.");
        }

        var graphicsDevice = MarshalInterface<IDirect3DDevice>.FromAbi(graphicsDevicePointer);
        Marshal.Release(graphicsDevicePointer);

        var itemInterop = GraphicsCaptureItem.As<IGraphicsCaptureItemInterop>();
        var itemPointer = itemInterop.CreateForWindow(hwnd, GraphicsCaptureItemGuid);
        if (itemPointer == IntPtr.Zero)
        {
            throw new InvalidOperationException("CreateForWindow returned a null capture item.");
        }

        var captureItem = GraphicsCaptureItem.FromAbi(itemPointer);
        Marshal.Release(itemPointer);

        using var framePool = Direct3D11CaptureFramePool.CreateFreeThreaded(
            graphicsDevice,
            DirectXPixelFormat.B8G8R8A8UIntNormalized,
            1,
            captureItem.Size);
        using var session = framePool.CreateCaptureSession(captureItem);
        session.IsCursorCaptureEnabled = options.IncludeCursor;

        var frameTask = new TaskCompletionSource<SoftwareBitmap>(
            TaskCreationOptions.RunContinuationsAsynchronously);

        TypedEventHandler<Direct3D11CaptureFramePool, object> handler = async (sender, _) =>
        {
            try
            {
                using var frame = sender.TryGetNextFrame();
                var bitmap = await SoftwareBitmap.CreateCopyFromSurfaceAsync(
                    frame.Surface,
                    BitmapAlphaMode.Premultiplied);
                frameTask.TrySetResult(bitmap);
            }
            catch (Exception error)
            {
                frameTask.TrySetException(error);
            }
        };

        framePool.FrameArrived += handler;
        try
        {
            session.StartCapture();
            var completedTask = await Task.WhenAny(
                frameTask.Task,
                Task.Delay(TimeSpan.FromMilliseconds(options.TimeoutMs)));
            if (completedTask != frameTask.Task)
            {
                throw new TimeoutException(
                    $"Timed out after {options.TimeoutMs}ms waiting for a capture frame.");
            }

            using var softwareBitmap = await frameTask.Task;
            var cropBounds = ResolveCropBounds(
                options,
                softwareBitmap.PixelWidth,
                softwareBitmap.PixelHeight);
            await SaveBitmapAsync(softwareBitmap, options.OutputPath, options.Format, cropBounds);

            return new
            {
                outputPath = options.OutputPath,
                format = options.Format,
                itemWidth = captureItem.Size.Width,
                itemHeight = captureItem.Size.Height,
                bitmapWidth = softwareBitmap.PixelWidth,
                bitmapHeight = softwareBitmap.PixelHeight,
                outputWidth = cropBounds is BitmapBounds outputBounds ? (int)outputBounds.Width : softwareBitmap.PixelWidth,
                outputHeight = cropBounds is BitmapBounds outputHeightBounds ? (int)outputHeightBounds.Height : softwareBitmap.PixelHeight,
                cropLeft = cropBounds is BitmapBounds cropLeftBounds ? (int)cropLeftBounds.X : 0,
                cropTop = cropBounds is BitmapBounds cropTopBounds ? (int)cropTopBounds.Y : 0,
                cropWidth = cropBounds is BitmapBounds cropWidthBounds ? (int)cropWidthBounds.Width : softwareBitmap.PixelWidth,
                cropHeight = cropBounds is BitmapBounds cropHeightBounds ? (int)cropHeightBounds.Height : softwareBitmap.PixelHeight,
                includeCursor = options.IncludeCursor,
            };
        }
        finally
        {
            framePool.FrameArrived -= handler;
        }
    }

    private static async Task SaveBitmapAsync(
        SoftwareBitmap bitmap,
        string outputPath,
        string format,
        BitmapBounds? cropBounds)
    {
        using var stream = new InMemoryRandomAccessStream();
        var encoderId = format == "jpg"
            ? BitmapEncoder.JpegEncoderId
            : BitmapEncoder.PngEncoderId;
        var encoder = await BitmapEncoder.CreateAsync(encoderId, stream);
        if (cropBounds is BitmapBounds bounds)
        {
            encoder.BitmapTransform.Bounds = bounds;
        }
        encoder.SetSoftwareBitmap(bitmap);
        await encoder.FlushAsync();

        stream.Seek(0);
        var length = checked((int)stream.Size);
        using var reader = new DataReader(stream.GetInputStreamAt(0));
        await reader.LoadAsync((uint)length);
        var bytes = new byte[length];
        reader.ReadBytes(bytes);
        await File.WriteAllBytesAsync(outputPath, bytes);
    }

    private static string ReadRequiredArg(string[] args, string flagName)
    {
        return ReadOptionalArg(args, flagName)
            ?? throw new InvalidOperationException($"Missing required argument {flagName}=...");
    }

    private static string? ReadOptionalArg(string[] args, string flagName)
    {
        var argument = args.FirstOrDefault(
            entry => entry.StartsWith($"{flagName}=", StringComparison.OrdinalIgnoreCase));
        if (argument is null)
        {
            return null;
        }

        var value = argument[(flagName.Length + 1)..].Trim();
        return value.Length == 0 ? null : value;
    }

    private static ScreenRect? ParseOptionalScreenRect(string[] args, string rectName)
    {
        var leftRaw = ReadOptionalArg(args, $"--{rectName}-left");
        var topRaw = ReadOptionalArg(args, $"--{rectName}-top");
        var rightRaw = ReadOptionalArg(args, $"--{rectName}-right");
        var bottomRaw = ReadOptionalArg(args, $"--{rectName}-bottom");

        if (leftRaw is null && topRaw is null && rightRaw is null && bottomRaw is null)
        {
            return null;
        }

        if (leftRaw is null || topRaw is null || rightRaw is null || bottomRaw is null)
        {
            throw new InvalidOperationException(
                $"--{rectName}-left/top/right/bottom must all be provided together.");
        }

        var left = ParseInt(leftRaw, $"--{rectName}-left");
        var top = ParseInt(topRaw, $"--{rectName}-top");
        var right = ParseInt(rightRaw, $"--{rectName}-right");
        var bottom = ParseInt(bottomRaw, $"--{rectName}-bottom");

        if (right <= left || bottom <= top)
        {
            throw new InvalidOperationException(
                $"--{rectName}-* must describe a non-empty rect.");
        }

        return new ScreenRect(left, top, right, bottom);
    }

    private static BitmapBounds? ResolveCropBounds(CaptureOptions options, int bitmapWidth, int bitmapHeight)
    {
        if (options.WindowRect is null || options.ClientRect is null)
        {
            return null;
        }

        var windowRect = options.WindowRect;
        var clientRect = options.ClientRect;
        if (windowRect.Width <= 0 || windowRect.Height <= 0)
        {
            throw new InvalidOperationException("Window rect for crop mapping is empty.");
        }

        var scaleX = bitmapWidth / (double)windowRect.Width;
        var scaleY = bitmapHeight / (double)windowRect.Height;
        var left = (int)Math.Round((clientRect.Left - windowRect.Left) * scaleX);
        var top = (int)Math.Round((clientRect.Top - windowRect.Top) * scaleY);
        var right = (int)Math.Round((clientRect.Right - windowRect.Left) * scaleX);
        var bottom = (int)Math.Round((clientRect.Bottom - windowRect.Top) * scaleY);

        left = Math.Clamp(left, 0, bitmapWidth);
        top = Math.Clamp(top, 0, bitmapHeight);
        right = Math.Clamp(right, 0, bitmapWidth);
        bottom = Math.Clamp(bottom, 0, bitmapHeight);

        if (right <= left || bottom <= top)
        {
            throw new InvalidOperationException(
                "Client area crop resolved outside the captured window content.");
        }

        return new BitmapBounds
        {
            X = (uint)left,
            Y = (uint)top,
            Width = (uint)(right - left),
            Height = (uint)(bottom - top),
        };
    }

    private static long ParseHandle(string rawValue)
    {
        var style = rawValue.StartsWith("0x", StringComparison.OrdinalIgnoreCase)
            ? System.Globalization.NumberStyles.HexNumber
            : System.Globalization.NumberStyles.Integer;
        var value = rawValue.StartsWith("0x", StringComparison.OrdinalIgnoreCase)
            ? rawValue[2..]
            : rawValue;
        if (!long.TryParse(
                value,
                style,
                System.Globalization.CultureInfo.InvariantCulture,
                out var parsed)
            || parsed <= 0)
        {
            throw new InvalidOperationException(
                $"--handle must be a positive decimal or 0x-prefixed hex number, got \"{rawValue}\".");
        }

        return parsed;
    }

    private static int ParseInt(string rawValue, string flagName)
    {
        if (!int.TryParse(rawValue, out var parsed))
        {
            throw new InvalidOperationException(
                $"{flagName} must be an integer, got \"{rawValue}\".");
        }

        return parsed;
    }

    private static int ParsePositiveInt(string? rawValue, int defaultValue, string flagName)
    {
        if (string.IsNullOrWhiteSpace(rawValue))
        {
            return defaultValue;
        }

        if (!int.TryParse(rawValue, out var parsed) || parsed <= 0)
        {
            throw new InvalidOperationException(
                $"{flagName} must be a positive integer, got \"{rawValue}\".");
        }

        return parsed;
    }
}
