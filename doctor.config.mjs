// Scan authored application, worker, server, and test sources. Registry components
// are maintained by shadcn; the generated worker bundle is checked at its source.
/** @type {import("react-doctor/api").ReactDoctorConfig} */
export default {
  ignore: {
    files: ["public/eeevp-sw.js", "src/components/ui/**"],
  },
  surfaces: {
    ciFailure: {
      includeTags: ["design"],
      includeFileContexts: ["test", "story"],
    },
  },
};
