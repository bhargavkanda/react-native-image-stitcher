#!/usr/bin/env ruby
# SPDX-License-Identifier: Apache-2.0
#
# wire_bridge_delegate.rb — one-shot Xcode project edit for F8.0.d.
#
# Adds ReactNativeBridgeDelegate.{h,mm} + the bridging header to the
# example app target, and sets SWIFT_OBJC_BRIDGING_HEADER on Debug
# and Release.  Idempotent: re-running is a no-op once the files +
# build setting are already in place.
#
# Usage:
#   cd example/ios
#   bundle exec ruby scripts/wire_bridge_delegate.rb
#   # OR: ruby scripts/wire_bridge_delegate.rb   (if the xcodeproj
#   # gem is in your bundle path already, e.g. via cocoapods)

require 'xcodeproj'

PROJECT_PATH = File.expand_path('../RNImageStitcherExample.xcodeproj', __dir__)
TARGET_NAME = 'RNImageStitcherExample'
GROUP_NAME = 'RNImageStitcherExample'
BRIDGING_HEADER = 'RNImageStitcherExample/RNImageStitcherExample-Bridging-Header.h'

FILES_TO_ADD = [
  { relative: 'RNImageStitcherExample/ReactNativeBridgeDelegate.h',
    compile: false },
  { relative: 'RNImageStitcherExample/ReactNativeBridgeDelegate.mm',
    compile: true },
  { relative: 'RNImageStitcherExample/RNImageStitcherExample-Bridging-Header.h',
    compile: false },
]

project = Xcodeproj::Project.open(PROJECT_PATH)
target = project.targets.find { |t| t.name == TARGET_NAME }
abort("Target #{TARGET_NAME} not found") unless target

group = project.main_group.find_subpath(GROUP_NAME, true)

FILES_TO_ADD.each do |spec|
  basename = File.basename(spec[:relative])
  existing = group.files.find { |f| f.path == basename || f.path == spec[:relative] }
  if existing
    puts "[wire] #{basename}: already in project group, skipping add"
    file_ref = existing
  else
    puts "[wire] #{basename}: adding to project"
    # `new_file` sets `source_tree` to <group> and `path` relative to
    # the group's real path on disk.  Pass the absolute path so
    # xcodeproj resolves the file_ref correctly regardless of how the
    # group's source_tree is configured (some projects nest groups
    # without filesystem dirs, which trips up the relative-path
    # heuristic and yields `example/ios/<basename>` instead of
    # `example/ios/RNImageStitcherExample/<basename>`).
    abs_path = File.expand_path(spec[:relative], File.dirname(PROJECT_PATH))
    file_ref = group.new_file(abs_path)
  end

  if spec[:compile]
    sources_phase = target.source_build_phase
    already_compiled = sources_phase.files_references.any? { |fr| fr == file_ref }
    if already_compiled
      puts "[wire] #{basename}: already in Compile Sources, skipping"
    else
      puts "[wire] #{basename}: adding to Compile Sources"
      sources_phase.add_file_reference(file_ref)
    end
  end
end

# Set SWIFT_OBJC_BRIDGING_HEADER on every build configuration of the
# target.  Idempotent.
target.build_configurations.each do |config|
  current = config.build_settings['SWIFT_OBJC_BRIDGING_HEADER']
  if current == BRIDGING_HEADER
    puts "[wire] config '#{config.name}': SWIFT_OBJC_BRIDGING_HEADER already set"
  else
    puts "[wire] config '#{config.name}': SWIFT_OBJC_BRIDGING_HEADER = #{BRIDGING_HEADER}"
    config.build_settings['SWIFT_OBJC_BRIDGING_HEADER'] = BRIDGING_HEADER
  end
end

project.save
puts "[wire] project saved"
