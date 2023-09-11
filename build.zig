const std = @import("std");

pub fn build(b: *std.Build) void {
    const optimize = b.standardOptimizeOption(.{});

    const bundle_step = blk: {
        const bundle_exe = b.addExecutable(.{
            .name = "bundle-resources",
            .root_source_file = .{ .path = "./bundle.zig" },
        });

        const lib_step = b.addSharedLibrary(.{
            .name = "zig-wasm-dsp",
            .root_source_file = .{ .path = "src/main.zig" },
            .optimize = optimize,
            .target = .{
                .cpu_arch = .wasm32,
                .os_tag = .freestanding,
            },
        });

        lib_step.rdynamic = true;

        const bstep = b.addRunArtifact(bundle_exe);

        bstep.addArg("worklet-wrapper");
        bstep.addFileArg(.{ .path = "resources/worklet.js" });

        bstep.addArg("graph-texture");
        bstep.addFileArg(.{ .path = "resources/lissajous-graph.png" });

        bstep.addArg("heatmap-scale");
        bstep.addFileArg(.{ .path = "resources/hms.jpg" });

        bstep.addArg(lib_step.name);
        bstep.addArtifactArg(lib_step);

        break :blk bstep;
    };

    {
        const install_dir = std.Build.InstallDir{ .custom = "html" };
        const install_step = b.getInstallStep();

        const bundle_output = bundle_step.captureStdOut();
        const install_bundle = b.addInstallFileWithDir(bundle_output, install_dir, "resources.js");

        const install_browser_files = b.addInstallDirectory(.{
            .source_dir = .{ .path = "browser" },
            .install_dir = install_dir,
            .install_subdir = "",
        });

        install_step.dependOn(&install_bundle.step);
        install_step.dependOn(&install_browser_files.step);
    }
}
