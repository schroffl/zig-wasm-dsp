const std = @import("std");
const Builder = @import("std").build.Builder;
const HTMLStep = @import("./src/build_html.zig").HTMLStep;

pub fn build(b: *Builder) void {
    // Standard release options allow the person running `zig build` to select
    // between Debug, ReleaseSafe, ReleaseFast, and ReleaseSmall.
    const mode = b.standardReleaseOptions();

    const install_dir = std.build.InstallDir{ .Custom = "html" };
    const copy_step = b.addInstallDirectory(.{
        .source_dir = "browser",
        .install_dir = install_dir,
        .install_subdir = "",
    });

    const resource_step = ResourceStep.init(b, "resources", install_dir);
    resource_step.addResource("worklet-wrapper", "resources/worklet.js");
    resource_step.addResource("graph-texture", "resources/lissajous-graph.png");

    const wasm_step = resource_step.addWasmResource("zig-wasm-dsp", "src/main.zig");
    wasm_step.setBuildMode(mode);

    resource_step.step.dependOn(&copy_step.step);
    b.default_step.dependOn(&resource_step.step);
}

const ResourceStep = struct {
    builder: *Builder,
    step: std.build.Step,
    install_dir: std.build.InstallDir,
    filename: []const u8,
    resources: std.StringHashMap([]const u8),
    wasm_resources: std.StringHashMap(*std.build.LibExeObjStep),

    pub fn init(b: *Builder, filename: []const u8, dir: std.build.InstallDir) *ResourceStep {
        var self = b.allocator.create(ResourceStep) catch unreachable;

        self.builder = b;
        self.step = std.build.Step.init(.Custom, "wrap-resources", b.allocator, make);
        self.install_dir = dir;
        self.filename = filename;
        self.resources = std.StringHashMap([]const u8).init(b.allocator);
        self.wasm_resources = std.StringHashMap(*std.build.LibExeObjStep).init(b.allocator);

        return self;
    }

    pub fn addResource(self: *ResourceStep, name: []const u8, file_path: []const u8) void {
        self.resources.putNoClobber(name, file_path) catch unreachable;
    }

    pub fn addWasmResource(self: *ResourceStep, name: []const u8, root_src: []const u8) *std.build.LibExeObjStep {
        var lib_step = self.builder.addStaticLibrary(name, root_src);
        lib_step.setTarget(.{
            .cpu_arch = .wasm32,
            .os_tag = .freestanding,
        });

        self.step.dependOn(&lib_step.step);
        self.wasm_resources.putNoClobber(name, lib_step) catch unreachable;
        return lib_step;
    }

    fn make(step: *std.build.Step) !void {
        var self = @fieldParentPtr(ResourceStep, "step", step);
        var wasm_it = self.wasm_resources.iterator();

        while (wasm_it.next()) |wasm_entry| {
            const lib_output_path = wasm_entry.value.getOutputPath();
            self.addResource(wasm_entry.key, lib_output_path);
        }

        var resource_it = self.resources.iterator();

        const install_filename = self.builder.fmt("{s}.js", .{self.filename});
        const install_path = self.builder.getInstallPath(self.install_dir, install_filename);
        var out_file = try std.fs.cwd().createFile(install_path, .{});
        defer out_file.close();

        var build_dir = try std.fs.cwd().openDir(self.builder.build_root, .{});
        defer build_dir.close();

        while (resource_it.next()) |entry| {
            var in_file = try build_dir.openFile(entry.value, .{ .read = true });
            defer in_file.close();

            const stat = try in_file.stat();
            const content = try in_file.readToEndAlloc(self.builder.allocator, stat.size);
            defer self.builder.allocator.free(content);

            const base64_len = std.base64.Base64Encoder.calcSize(content.len);
            const base64_buffer = try self.builder.allocator.alloc(u8, base64_len);
            defer self.builder.allocator.free(base64_buffer);

            const final_base64 = std.base64.standard_encoder.encode(base64_buffer, content);

            try out_file.writeAll("window[\"");
            try out_file.writeAll(entry.key);
            try out_file.writeAll("\"] = \"");
            try out_file.writeAll(final_base64);
            try out_file.writeAll("\";\n");
        }
    }
};
