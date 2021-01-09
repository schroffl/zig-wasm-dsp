const std = @import("std");
const Builder = @import("std").build.Builder;
const HTMLStep = @import("./src/build_html.zig").HTMLStep;

pub fn build(b: *Builder) void {
    // Standard release options allow the person running `zig build` to select
    // between Debug, ReleaseSafe, ReleaseFast, and ReleaseSmall.
    const mode = b.standardReleaseOptions();

    const install_dir = std.build.InstallDir{ .Custom = "html" };
    const js_dir = std.build.InstallDir{ .Custom = "html/js" };

    const wrap_step = WrapJavascriptStep.init(b, "zig-wasm-dsp", .{ .ZigToWebAssembly = "src/main.zig" }, install_dir);
    const worklet_step = WrapJavascriptStep.init(b, "worklet-wrapper", .{ .JavaScript = "browser/js/worklet.js" }, install_dir);
    const texture_step = WrapJavascriptStep.init(b, "graph-texture", .{ .JavaScript = "browser/img/lissajous_graph.png" }, js_dir);
    const copy_step = b.addInstallDirectory(.{
        .source_dir = "browser",
        .install_dir = install_dir,
        .install_subdir = "",
    });

    wrap_step.step.dependOn(&copy_step.step);
    worklet_step.step.dependOn(&wrap_step.step);
    texture_step.step.dependOn(&worklet_step.step);

    b.default_step.dependOn(&texture_step.step);
}

const WrapJavascriptStep = struct {
    builder: *Builder,
    step: std.build.Step,
    install_dir: std.build.InstallDir,
    name: []const u8,

    source_type: SourceType,
    wasm_lib_step: ?*std.build.LibExeObjStep,

    const SourceType = union(enum) {
        JavaScript: []const u8,
        ZigToWebAssembly: []const u8,
    };

    pub fn init(b: *Builder, name: []const u8, root_src: SourceType, dir: std.build.InstallDir) *WrapJavascriptStep {
        var self = b.allocator.create(WrapJavascriptStep) catch unreachable;

        self.step = std.build.Step.init(.Custom, "Wrap Javascript", b.allocator, make);
        self.builder = b;
        self.name = name;
        self.install_dir = dir;
        self.source_type = root_src;

        self.wasm_lib_step = switch (root_src) {
            .ZigToWebAssembly => |wasm_path| result: {
                var lib_step = b.addStaticLibrary(name, wasm_path);
                lib_step.setTarget(.{
                    .cpu_arch = .wasm32,
                    .os_tag = .freestanding,
                });

                self.step.dependOn(&lib_step.step);

                break :result lib_step;
            },
            else => null,
        };

        return self;
    }

    pub fn setBuildMode(self: *WrapJavascriptStep, mode: std.builtin.Mode) void {
        if (self.wasm_lib_step) |lib_step|
            lib_step.setBuildMode(mode);
    }

    fn make(step: *std.build.Step) !void {
        const self = @fieldParentPtr(WrapJavascriptStep, "step", step);
        const lib_output_path = switch (self.source_type) {
            .JavaScript => |js_path| js_path,
            .ZigToWebAssembly => self.wasm_lib_step.?.getOutputPath(),
        };

        const install_filename = self.builder.fmt("{s}.js", .{self.name});
        const install_dirname = self.builder.getInstallPath(self.install_dir, "");
        const install_path = self.builder.getInstallPath(self.install_dir, install_filename);

        try self.builder.makePath(install_dirname);

        var file = try std.fs.cwd().openFile(lib_output_path, .{ .read = true });
        defer file.close();

        const stat = try file.stat();
        const content = try file.readToEndAlloc(self.builder.allocator, stat.size);
        defer self.builder.allocator.free(content);

        const base64_len = std.base64.Base64Encoder.calcSize(content.len);
        const base64_buffer = try self.builder.allocator.alloc(u8, base64_len);
        defer self.builder.allocator.free(base64_buffer);

        var out_file = try std.fs.cwd().createFile(install_path, .{});
        defer out_file.close();
        var writer = out_file.writer();

        try writer.writeAll("window[\"");
        try writer.writeAll(self.name);
        try writer.writeAll("\"] = \"");

        const final_base64 = std.base64.standard_encoder.encode(base64_buffer, content);
        try writer.writeAll(final_base64);
        try writer.writeAll("\";\n");
    }
};
