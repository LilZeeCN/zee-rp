// Compiled locally against the installed runtime. No Axure binary is a build input.
using System;
using System.Collections;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;

internal static class Worker
{
    private const BindingFlags All = BindingFlags.Public | BindingFlags.NonPublic |
        BindingFlags.Static | BindingFlags.Instance;
    private const string Objects = "Axure.DocumentModel.Objects.";
    private static Assembly app;
    private static bool rp11;

    // RP 9 and RP 11 intentionally have separate, build-qualified symbol bindings.
    private static string Pick(string nine, string eleven) => rp11 ? eleven : nine;
    private static Type TypeOf(string name) => app.GetType(name, true);
    private static object Construct(string name, params object[] args) =>
        Activator.CreateInstance(TypeOf(name), All & ~BindingFlags.Static, null, args, CultureInfo.InvariantCulture);
    private static PropertyInfo Property(object owner, string name) =>
        owner.GetType().GetProperty(name, All) ?? throw new MissingMemberException(owner.GetType().FullName, name);
    private static object Get(object owner, string name) => Property(owner, name).GetValue(owner);
    private static void Set(object owner, string name, object value) => Property(owner, name).SetValue(owner, value);

    private static object Call(object owner, string name, params object[] args)
    {
        var type = owner as Type ?? owner.GetType();
        var matches = type.GetMethods(All).Where(method =>
            method.Name == name && method.GetParameters().Length == args.Length).ToArray();
        if (matches.Length != 1)
            throw new MissingMethodException(type.FullName, name + "/" + args.Length);
        return matches[0].Invoke(owner is Type ? null : owner, args);
    }

    // Mono emits its own stdout banner. A framed line distinguishes results from runtime logs.
    private static void Emit(string kind, params object[] columns)
    {
        var encoded = columns.Select(value => Convert.ToBase64String(
            Encoding.UTF8.GetBytes(Convert.ToString(value, CultureInfo.InvariantCulture) ?? "")));
        Console.WriteLine("zee-assembly:" + kind + "\t" + string.Join("\t", encoded));
    }

    [DllImport("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")]
    private static extern IntPtr CFURLCreateFromFileSystemRepresentation(
        IntPtr allocator, byte[] path, IntPtr length, byte isDirectory);

    [DllImport("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")]
    private static extern void CFRelease(IntPtr value);

    [DllImport("/System/Library/Frameworks/CoreText.framework/CoreText")]
    private static extern byte CTFontManagerRegisterFontsForURL(IntPtr url, uint scope, IntPtr error);

    private static void LoadThemeFonts(string resources)
    {
        string family = Pick("NunitoSans", "Inter");
        string[] files = Directory.GetFiles(Path.Combine(resources, "Fonts"), family + "-*.ttf");
        if (files.Length == 0)
            throw new FileNotFoundException("Missing Axure theme fonts: " + family);
        foreach (string path in files)
        {
            byte[] bytes = Encoding.UTF8.GetBytes(path);
            IntPtr url = CFURLCreateFromFileSystemRepresentation(
                IntPtr.Zero, bytes, (IntPtr)bytes.Length, 0);
            if (url == IntPtr.Zero)
                throw new IOException("Could not create font URL: " + path);
            try
            {
                // kCTFontManagerScopeProcess. AppKit checks the font when its theme is created.
                CTFontManagerRegisterFontsForURL(url, 1, IntPtr.Zero);
            }
            finally
            {
                CFRelease(url);
            }
        }
    }

    private static object InitializeMac(string resources, string temporaryDirectory)
    {
        Type platform = TypeOf(Pick("ECMA.XCMk", "fApN.VApf"));
        TypeOf("MObjc.Registrar").GetProperty("CanInit", All).SetValue(null, true);
        object pool = Call(TypeOf("MCocoa.NSAutoreleasePool"), "Create");
        Call(TypeOf("MCocoa.NSApplication"), "sharedApplication");
        LoadThemeFonts(resources);
        Call(platform, Pick("sCMc", "sApo"), Construct("Axure.Platform.Mac.MXPlatformInformation"));
        Call(platform, Pick("gCML", "kAps"), Construct("Axure.Platform.Mac.MXPlatformServices"));
        object files = Call(platform, Pick("NCKY", "IApG"));
        Call(files, Pick("SIG1", "lAfu"), resources);
        // Own the worker's temporary files without initializing the desktop's cleanup routines.
        TypeOf(Pick("sIGo.BIGr", "QAf5.TAf0"))
            .GetMethod(Pick("UIGW", "aAf9"), All).Invoke(files, new object[] { temporaryDirectory });
        Call(TypeOf(Pick("bn8.VnP", "uek.Mey")), Pick("cnY", "feq"));
        return pool;
    }

    private static object Document(object file) => Call(file, Pick("UOpj", "sIeN"));
    private static object Sitemap(object file) => Get(Document(file), "Sitemap");

    private static void Load(object file, string path)
    {
        object mode = Enum.Parse(TypeOf("Axure.IO.AccessMode"), "Read");
        object[] args = rp11 ? new object[] { path, null, false, mode }
            : new object[] { path, null, false, mode, false };
        if (!(bool)Call(file, "Load", args))
            throw new InvalidDataException("Axure Load failed: " + args[1]);
    }

    private static void Save(object file, object page, string path)
    {
        Call(file, Pick("YOuN", "pIAO"), page, null);
        Call(file, Pick("UOux", "JIAU"));
        Call(file, Pick("oOun", "oIAl"), path, false);
    }

    private static void Create(object file, string path, int? maxLength, string secondPath, int? secondMaxLength)
    {
        object standard = Enum.Parse(TypeOf("Axure.Platform.ObjectPersistanceContext.DesignDocumentType"), "Standard");
        Call(TypeOf(Pick("vOOd.COOE", "WbM3.RbM7")), Pick("gOOB", "VbMz"), file, standard, null);
        object sitemap = Sitemap(file);
        object first = ((IEnumerable)Get(Get(sitemap, "Tree"), "Children")).Cast<object>().Single();
        object id = Call(sitemap, Pick("jODm", "nbG8"), first);
        object page = Construct(Pick("rOsF.JOs9", "MbRv.CbRj"), Document(file), null);
        using ((IDisposable)page)
        {
            Call(page, Pick("snU4", "bV6k"), id);
            object widget = null;
            if (maxLength.HasValue)
            {
                widget = Construct(Objects + "TextBox", page);
                Set(widget, "Name", "Native input");
                Set(widget, "Text", "");
                object rect = Construct(Get(widget, "Rect").GetType().FullName, 20.0, 20.0, 220.0, 32.0);
                Call(widget, Pick("NOvd", "FbsR"), rect, false);
                Set(widget, "MaxLength", maxLength.Value);
                Call(Get(page, "DiagramObjects"), "Add", widget);
            }
            Save(file, page, path);
            if (secondPath != null)
            {
                Set(widget, "MaxLength", secondMaxLength.Value);
                Save(file, page, secondPath);
            }
        }
    }

    private static void Inspect(object file)
    {
        var ids = (IEnumerable)Call(Sitemap(file), Pick("DODD", "rbG1"));
        foreach (object id in ids)
        {
            object page = Call(file, Pick("GOub", "gIAd"), id, true, null, Guid.Empty, null);
            if (page == null)
                throw new InvalidDataException("Missing page object: " + id);
            using ((IDisposable)page)
            {
                Emit("page", id, Get(page, "Name"));
                foreach (object widget in (IEnumerable)Get(page, "DiagramObjects"))
                {
                    object maxLength = widget.GetType().FullName == Objects + "TextBox"
                        ? Get(widget, "MaxLength") : null;
                    Emit("widget", id, widget.GetType().Name, Get(widget, "Name"),
                        Get(widget, "X"), Get(widget, "Y"), Get(widget, "Width"), Get(widget, "Height"), maxLength);
                }
            }
        }
    }

    private static void Export(object file, string destination)
    {
        var doc = Document(file);
        var config = Construct(Pick("lOc0.fOcS", "UIGf.dIGM"), doc);
        using ((IDisposable)config)
        {
            Call(config, Pick("EOco", "qIGp"), destination);
            object generator = Construct(Pick("IFrW.pFr1", "SiGn.WiGF"), config);
            object styles = Get(doc, "StyleSheet");

            // Invoke the local HTML write pipeline below the method that opens a browser.
            Call(generator, Pick("sFrz", "Eitx"));
            Call(generator, Pick("sFoH", "Ditq"), styles);
            Call(generator, Pick("fFoj", "Hity"), doc);
            using ((IDisposable)Call(generator, Pick("mFrB", "Aitc")))
            {
                using ((IDisposable)Call(file, Pick("GOuU", "IIAp"), true))
                {
                    if (!(bool)Call(generator, Pick("VFr7", "fitC"), file, null, null, null))
                        throw new InvalidOperationException("Axure stopped HTML generation");
                }
                Call(generator, Pick("nFoY", "Jitp"), styles);
            }
        }
    }

    private static void Members(string name)
    {
        Type type = TypeOf(name);
        Emit("type", type.FullName, type.BaseType?.FullName);
        foreach (var member in type.GetMembers(All | BindingFlags.DeclaredOnly)
            .OrderBy(member => member.Name, StringComparer.Ordinal).ThenBy(member => member.MetadataToken))
            Emit("member", member.MemberType, member.Name, member.ToString());
        if (type.IsEnum)
        {
            foreach (string value in Enum.GetNames(type))
                Emit("enum", value, Convert.ToInt64(Enum.Parse(type, value), CultureInfo.InvariantCulture));
        }
    }

    private static void Catalog()
    {
        foreach (Type type in app.GetTypes().Where(t => !t.IsNested &&
            (t.FullName.StartsWith(Objects, StringComparison.Ordinal) ||
             t.FullName.StartsWith("Axure.DocumentModel.Interaction.", StringComparison.Ordinal) ||
             t.FullName.StartsWith("Axure.DocumentModel.Expressions.", StringComparison.Ordinal)))
            .OrderBy(t => t.FullName, StringComparer.Ordinal))
            Emit("type", type.FullName, type.BaseType?.FullName);
        Members("Axure.Constants.IxEventType");
    }

    public static int Main(string[] args)
    {
        try
        {
            app = Assembly.LoadFrom(args[0]);
            AppDomain.CurrentDomain.AssemblyResolve += (sender, request) =>
            {
                string path = Path.Combine(Path.GetDirectoryName(args[0]),
                    new AssemblyName(request.Name).Name + ".dll");
                return File.Exists(path) ? Assembly.LoadFrom(path) : null;
            };
            rp11 = app.GetName().Version.Major == 11;
            if (!string.Equals(app.ManifestModule.ModuleVersionId.ToString(), args[1], StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("Axure module identity changed");
            Emit("identity", app.GetName().Version, app.ManifestModule.ModuleVersionId,
                RuntimeInformation.ProcessArchitecture, Environment.Version);
            string command = args[2];
            switch (command)
            {
                case "probe": return 0;
                case "members": Members(args[5]); return 0;
                case "catalog": Catalog(); return 0;
            }

            object pool = InitializeMac(args[3], args[4]);
            object file = Construct(Pick("XOgG.xOgB", "zIIT.III9"));
            using ((IDisposable)file)
            {
                switch (command)
                {
                    case "create":
                        Create(file, args[5], args.Length == 7 ? int.Parse(args[6], CultureInfo.InvariantCulture)
                            : (int?)null, null, null);
                        break;
                    case "pair":
                        Create(file, args[5], int.Parse(args[6], CultureInfo.InvariantCulture), args[7],
                            int.Parse(args[8], CultureInfo.InvariantCulture));
                        break;
                    case "inspect":
                        Load(file, args[5]);
                        Inspect(file);
                        break;
                    case "export":
                        Load(file, args[5]);
                        Export(file, args[6]);
                        break;
                    default:
                        throw new ArgumentException("Unsupported operation: " + command);
                }
            }
            GC.KeepAlive(pool);
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error);
            return 1;
        }
    }
}
