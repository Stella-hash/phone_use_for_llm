import Foundation
import Testing
@testable import iPhoneUse

struct MCPHTTPErrorTests {
    @Test func typedAndBridgedTimeoutsReportTheRequestDeadline() {
        let errors: [Error] = [URLError(.timedOut), NSError(domain: NSURLErrorDomain,
            code: URLError.timedOut.rawValue, userInfo: [NSLocalizedDescriptionKey: "synthetic deadline"])]
        for language: AppLanguage in [.en, .zh] {
            for error in errors {
                let result = MCPHTTPClient.requestError(error, timeout: 0.08, language: language)
                #expect(result.description == "HTTP response timed out after 0.08 seconds")
                #expect(!result.inputNotSent)
            }
        }
    }

    @Test func typedAndBridgedCancellationDoesNotClaimHostDeathOrUnsentInput() {
        let errors: [Error] = [URLError(.cancelled), NSError(domain: NSURLErrorDomain,
            code: URLError.cancelled.rawValue, userInfo: [NSLocalizedDescriptionKey: "synthetic cancellation"])]
        for language: AppLanguage in [.en, .zh] {
            for error in errors {
                let result = MCPHTTPClient.requestError(error, timeout: 0.08, language: language)
                #expect(result.description == "HTTP request was cancelled")
                #expect(!result.inputNotSent)
            }
        }
    }

    @Test func otherErrorsKeepTheExistingLocalizedDiagnostic() {
        let errors: [Error] = [URLError(.cannotConnectToHost), URLError(.networkConnectionLost),
            NSError(domain: "synthetic-non-url", code: URLError.timedOut.rawValue,
                    userInfo: [NSLocalizedDescriptionKey: "same numeric code, different domain"]),
            NSError(domain: "synthetic-non-url", code: URLError.cancelled.rawValue)]
        for language: AppLanguage in [.en, .zh] {
            for error in errors {
                let result = MCPHTTPClient.requestError(error, timeout: 0.08, language: language)
                #expect(result.description == StringsMCP(language: language).appNotRunning(error.localizedDescription))
            }
        }
    }
}
