# TypeScript Documentation Examples

## Complete Module Documentation Example

```typescript
/**
 * @packageDocumentation
 * # Authentication Module
 *
 * This module provides comprehensive authentication and authorization functionality
 * for the application, implementing JWT-based authentication with refresh tokens,
 * multi-factor authentication, and role-based access control.
 *
 * ## Features
 * - JWT authentication with access and refresh tokens
 * - OAuth2 integration for social logins
 * - Multi-factor authentication (MFA) support
 * - Role-based access control (RBAC)
 * - Session management across devices
 * - Password reset and account recovery
 *
 * ## Usage
 * ```typescript
 * // app.module.ts
 * import { AuthModule } from '@app/auth';
 *
 * @Module({
 *   imports: [
 *     AuthModule.register({
 *       jwtSecret: process.env.JWT_SECRET,
 *       accessTokenExpiry: '15m',
 *       refreshTokenExpiry: '7d',
 *       enableMfa: true
 *     })
 *   ]
 * })
 * export class AppModule {}
 * ```
 *
 * ## Security Considerations
 * - All tokens are signed with RS256 algorithm
 * - Refresh tokens are stored securely in database
 * - Rate limiting is applied to authentication endpoints
 * - Passwords are hashed using bcrypt with cost factor 12
 *
 * ## Architecture
 * This module follows the hexagonal architecture pattern with:
 * - Domain entities in `domain/`
 * - Application services in `application/`
 * - Infrastructure adapters in `infrastructure/`
 * - Presentation controllers in `presentation/`
 *
 * @module auth
 * @preferred
 */

export { AuthService } from './application/services/auth.service';
export { JwtAuthGuard } from './presentation/guards/jwt-auth.guard';
export { RolesGuard } from './presentation/guards/roles.guard';
export { AuthModule } from './auth.module';
export * from './domain/entities';
export * from './domain/repositories';
export * from './domain/value-objects';
```

## Complex Interface Documentation

```typescript
/**
 * User entity representing an authenticated user in the system
 * @interface User
 * @category Domain Entities
 * @subcategory User Management
 *
 * @remarks
 * This interface represents the core user entity in our domain model.
 * It includes authentication data, profile information, and metadata.
 * The entity is immutable - all updates return new instances.
 *
 * ## Example
 * ```typescript
 * const user: User = {
 *   id: "550e8400-e29b-41d4-a716-446655440000",
 *   email: "john.doe@example.com",
 *   roles: [UserRole.USER, UserRole.ADMIN],
 *   profile: {
 *     firstName: "John",
 *     lastName: "Doe",
 *     avatar: "https://example.com/avatar.jpg"
 *   },
 *   preferences: {
 *     theme: Theme.DARK,
 *     language: "en-US",
 *     timezone: "America/New_York"
 *   },
 *   security: {
 *     mfaEnabled: true,
 *     lastPasswordChange: new Date("2024-01-15"),
 *     loginAttempts: 0
 *   },
 *   metadata: {
 *     createdAt: new Date("2023-01-01"),
 *     updatedAt: new Date("2024-01-15"),
 *     createdBy: "system",
 *     version: 2
 *   }
 * };
 * ```
 *
 * ## Validation Rules
 * - `id` must be a valid UUID v4
 * - `email` must be a valid email format
 * - `roles` must contain at least one role
 * - `profile.firstName` and `profile.lastName` are required
 * - `preferences.language` must be a valid locale
 *
 * ## Invariants
 * - User ID is immutable once set
 * - Email is unique across all users
 * - At least one role is always assigned
 * - CreatedAt is never modified after creation
 *
 * @see {@link UserRole} for available roles
 * @see {@link UserProfile} for profile structure
 * @see {@link UserPreferences} for preference options
 * @see {@link UserSecurity} for security settings
 * @see {@link BaseMetadata} for metadata fields
 */
export interface User {
  /**
   * Unique identifier for the user
   * @remarks
   * Generated using UUID v4 algorithm for global uniqueness
   * This field is immutable after user creation
   * @format uuid
   * @example "550e8400-e29b-41d4-a716-446655440000"
   */
  readonly id: string;

  /**
   * User's email address - used as primary identifier for login
   * @remarks
   * Must be unique across all users in the system
   * Validated against RFC 5322 email format
   * Can be changed but requires email verification
   * @format email
   * @example "user@example.com"
   */
  email: string;

  /**
   * Array of roles assigned to the user for RBAC
   * @remarks
   * Determines user's permissions throughout the system
   * Must contain at least one role
   * Roles are additive - more roles = more permissions
   * @minItems 1
   * @uniqueItems true
   */
  roles: UserRole[];

  /**
   * User's profile information
   * @remarks
   * Contains personal and display information
   * All fields are optional except firstName and lastName
   * Can be updated by user or admin
   */
  profile: UserProfile;

  /**
   * User preferences and settings
   * @remarks
   * Controls UI/UX personalization
   * Applied immediately on change
   * Can be overridden by admin policies
   */
  preferences: UserPreferences;

  /**
   * Security-related information
   * @remarks
   * Tracks security settings and state
   * Used for access control and auditing
   * Some fields are read-only for users
   */
  security: UserSecurity;

  /**
   * System metadata for the user
   * @remarks
   * Automatically managed by the system
   * Contains audit trail and versioning info
   * Never directly modified by users
   */
  readonly metadata: BaseMetadata;
}
```

## Complex Class Documentation

```typescript
/**
 * Service for managing user authentication and authorization
 * @class AuthService
 * @category Application Services
 * @subcategory Authentication
 *
 * @remarks
 * Core service handling all authentication logic including:
 * - User login/logout with email/password
 * - JWT token generation and validation
 * - Refresh token management
 * - Multi-factor authentication flows
 * - Password reset and recovery
 * - Account lockout protection
 * - Session management across devices
 *
 * ## Architecture
 * This service is part of the application layer in our hexagonal architecture.
 * It orchestrates domain entities and infrastructure services without
 * containing business logic, which resides in domain entities.
 *
 * ## Dependencies
 * - {@link UserRepository} for user data access
 * - {@link JwtService} for token operations
 * - {@link HashService} for password hashing
 * - {@link EventBus} for domain events
 * - {@link RateLimiter} for brute force protection
 *
 * ## Security Considerations
 * - All passwords are hashed using bcrypt with cost factor 12
 * - JWT tokens use RS256 algorithm with rotating keys
 * - Refresh tokens are stored hashed in database
 * - Rate limiting prevents brute force attacks
 * - Account lockout after failed attempts
 * - CSRF protection on all state-changing operations
 *
 * ## Performance
 * - Average login time: ~200ms
 * - Token validation: ~5ms
 * - Uses Redis for session caching
 * - Connection pooling for database queries
 * - Lazy loading for user relationships
 *
 * ## Example Usage
 * ```typescript
 * const authService = new AuthService({
 *   userRepository,
 *   jwtService,
 *   hashService,
 *   eventBus,
 *   rateLimiter,
 *   config: {
 *     jwtSecret: process.env.JWT_SECRET!,
 *     accessTokenExpiry: '15m',
 *     refreshTokenExpiry: '7d',
 *     enableMfa: true,
 *     maxLoginAttempts: 5,
 *     lockoutDuration: '15m'
 *   }
 * });
 *
 * // Authenticate user
 * const result = await authService.login({
 *   email: 'user@example.com',
 *   password: 'password123',
 *   rememberMe: true
 * });
 *
 * if (result.success) {
 *   console.log('Access token:', result.accessToken);
 *   console.log('Refresh token:', result.refreshToken);
 * }
 * ```
 *
 * ## Error Handling
 * All methods return {@link Result} types for explicit error handling.
 * Common errors include:
 * - `InvalidCredentialsError` - Wrong email/password
 * - `AccountLockedError` - Account temporarily locked
 * - `TokenExpiredError` - Token has expired
 * - `InvalidTokenError` - Token is invalid or tampered
 *
 * @see {@link LoginCommand} for login parameters
 * @see {@link AuthResult} for authentication response
 * @see {@link User} for user entity structure
 * @see {@link JwtPayload} for token payload structure
 */
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  /**
   * Creates an instance of AuthService
   * @param dependencies - Service dependencies
   * @param dependencies.userRepository - User data access
   * @param dependencies.jwtService - JWT token operations
   * @param dependencies.hashService - Password hashing
   * @param dependencies.eventBus - Domain event publishing
   * @param dependencies.rateLimiter - Rate limiting service
   * @param dependencies.config - Service configuration
   */
  constructor(
    private readonly dependencies: AuthServiceDependencies
  ) {}

  /**
   * Authenticates a user with email and password
   * @param command - Login command with credentials
   * @returns Authentication result with tokens or error
   *
   * @remarks
   * Implements the complete login flow:
   * 1. Validates input data
   * 2. Checks rate limits for IP/email
   * 3. Retrieves user by email
   * 4. Verifies password hash
   * 5. Checks account status (active, not locked)
   * 6. Generates JWT tokens
   * 7. Updates last login timestamp
   * 8. Publishes UserLoggedIn event
   * 9. Returns tokens to caller
   *
   * @throws {ValidationError} If command data is invalid
   * @throws {RateLimitExceededError} If too many attempts
   * @throws {InvalidCredentialsError} If credentials don't match
   * @throws {AccountLockedError} If account is locked
   *
   * @security
   - Passwords are never logged
   * - Failed attempts are rate limited
   * - Account lockout prevents brute force
   * - Tokens are signed with private key
   *
   * @performance
   * - Average response time: 200ms
   * - Database query optimized with index
   * - Password hash uses bcrypt (100ms average)
   * - Token generation is synchronous (5ms)
   */
  async login(command: LoginCommand): Promise<Result<AuthResult, LoginError>> {
    this.logger.log(`Login attempt for email: ${command.email}`);

    // Implementation
  }

  /**
   * Refreshes an access token using a refresh token
   * @param refreshToken - Valid refresh token
   * @returns New access token or error
   *
   * @remarks
   * Implements secure token refresh:
   * - Validates refresh token signature and expiry
   * - Checks if token is in blacklist
   * - Retrieves associated user
   * - Generates new access token
   * - Optionally rotates refresh token
   *
   * @security
   * - Refresh tokens are single-use when rotation is enabled
   * - Tokens are checked against blacklist
   * - User must still be active
   */
  async refreshToken(
    refreshToken: string
  ): Promise<Result<RefreshResult, TokenError>> {
    this.logger.log('Token refresh requested');

    // Implementation
  }
}
```

## Generic Type Documentation

```typescript
/**
 * Repository pattern implementation for domain entities
 * @abstract
 * @class BaseRepository
 * @template T - Domain entity type (must extend BaseEntity)
 * @template K - Primary key type (string or number)
 * @template E - Error type for repository operations
 *
 * @remarks
 * Abstract base class implementing the repository pattern for
 * domain-driven design. Provides common CRUD operations while
 * allowing concrete implementations to define persistence details.
 *
 * ## Type Parameters
 * - `T` - The domain entity type being persisted
 *   - Must extend {@link BaseEntity}
 *   - Must have an `id` property of type `K`
 *   - Should be immutable (readonly properties)
 *
 * - `K` - The primary key type
 *   - Typically `string` (UUID) or `number` (auto-increment)
 *   - Must be serializable
 *   - Should be immutable once assigned
 *
 * - `E` - Custom error type for repository-specific errors
 *   - Extends {@link RepositoryError}
 *   - Allows typed error handling
 *   - Provides context-specific error information
 *
 * ## Example Implementation
 * ```typescript
 * interface User extends BaseEntity {
 *   readonly id: string;
 *   email: string;
 *   roles: UserRole[];
 * }
 *
 * class UserRepository extends BaseRepository<User, string, UserRepositoryError> {
 *   async findById(id: string): Promise<Result<User, UserRepositoryError>> {
 *     try {
 *       const user = await this.db.users.findUnique({ where: { id } });
 *       return user ? success(user) : failure(new UserNotFoundError(id));
 *     } catch (error) {
 *       return failure(new DatabaseError(error.message));
 *     }
 *   }
 *
 *   async save(user: User): Promise<Result<void, UserRepositoryError>> {
 *     try {
 *       await this.db.users.upsert({
 *         where: { id: user.id },
 *         update: user,
 *         create: user
 *       });
 *       return success(undefined);
 *     } catch (error) {
 *       return failure(new DatabaseError(error.message));
 *     }
 *   }
 *
 *   async findByEmail(email: string): Promise<Result<User[], UserRepositoryError>> {
 *     try {
 *       const users = await this.db.users.findMany({ where: { email } });
 *       return success(users);
 *     } catch (error) {
 *       return failure(new DatabaseError(error.message));
 *     }
 *   }
 * }
 * ```
 *
 * ## Performance Considerations
 * - Implement connection pooling in concrete classes
 * - Use database indexes for find operations
 * - Consider caching for frequently accessed entities
 * - Implement batch operations where appropriate
 *
 * ## Error Handling
 * - All operations return {@link Result} types
 * - Errors are typed and domain-specific
 * - Connection errors are wrapped appropriately
 * - Validation errors include field details
 *
 * @see {@link Result} for error handling pattern
 * @see {@link RepositoryError} for base error type
 * @see {@link BaseEntity} for entity requirements
 */
export abstract class BaseRepository<
  T extends BaseEntity,
  K extends string | number,
  E extends RepositoryError
> {
  /**
   * Finds an entity by its unique identifier
   * @abstract
   * @param id - The primary key value
   * @returns Result containing the entity or an error
   *
   * @remarks
   * This method should:
   * - Return null/failure if entity not found
   * - Return failure for database errors
   * - Validate the ID format
   * - Consider implementing caching
   *
   * @throws Never throws - returns Result instead
   */
  abstract findById(id: K): Promise<Result<T | null, E>>;

  /**
   * Persists an entity (create or update)
   * @abstract
   * @param entity - The entity to save
   * @returns Result indicating success or failure
   *
   * @remarks
   * Implementations should:
   * - Handle both create and update operations
   * - Validate entity before persisting
   * - Return appropriate errors for constraints
   * - Update metadata (updatedAt, version)
   */
  abstract save(entity: T): Promise<Result<void, E>>;

  /**
   * Deletes an entity by ID
   * @abstract
   * @param id - The primary key value
   * @returns Result indicating success or failure
   *
   * @remarks
   * Implementations should:
   * - Return success even if entity doesn't exist
   * - Handle cascade deletes if configured
   * - Consider soft delete vs hard delete
   * - Log deletion for audit purposes
   */
  abstract deleteById(id: K): Promise<Result<void, E>>;
}
```

## Decorator Documentation

```typescript
/**
 * Decorator for marking methods that require specific permissions
 * @decorator
 * @function RequirePermissions
 * @param permissions - Array of permission strings required
 * @param options - Additional configuration options
 * @returns Method decorator
 *
 * @remarks
 * This decorator implements declarative permission checking for class methods.
 * It integrates with the authorization system to verify that the current user
 * has all required permissions before method execution.
 *
 * ## Usage
 * ```typescript
 * class DocumentService {
 *   @RequirePermissions(['document:read', 'document:write'])
 *   async updateDocument(id: string, data: UpdateDocumentDto): Promise<Document> {
 *     // Method implementation
 *   }
 *
 *   @RequirePermissions(['admin:*'], { requireAll: false })
 *   async deleteDocument(id: string): Promise<void> {
 *     // Method implementation
 *   }
 * }
 * ```
 *
 * ## How it Works
 * 1. Intercepts method call before execution
 * 2. Retrieves current user from context
 * 3. Checks if user has required permissions
 * 4. Throws {@link InsufficientPermissionsError} if check fails
 * 5. Executes original method if check passes
 *
 * ## Options
 * - `requireAll` (default: true) - Whether all permissions are required
 * - `failOnMissing` (default: true) - Whether to fail if permissions missing
 * - `condition` - Custom condition function for dynamic checks
 *
 * ## Integration with Frameworks
 * ### NestJS
 * ```typescript
 * @Controller('documents')
 * export class DocumentController {
 *   @Post(':id')
 *   @RequirePermissions(['document:write'])
 *   async update(
 *     @Param('id') id: string,
 *     @Body() data: UpdateDocumentDto
 *   ) {
 *     // Controller logic
 *   }
 * }
 * ```
 *
 * ## Performance
 * - Permission check is cached for request lifecycle
 * - Decorator adds minimal overhead (<1ms)
 * - Works with async and sync methods
 *
 * ## Error Handling
 * - Throws {@link InsufficientPermissionsError} on permission failure
 * - Includes required and actual permissions in error
 * - Integrates with global exception handlers
 *
 * @see {@link PermissionService} for permission checking logic
 * @see {@link InsufficientPermissionsError} for error details
 * @see {@link AuthorizationContext} for context requirements
 */
export function RequirePermissions(
  permissions: string[],
  options: PermissionOptions = {}
): MethodDecorator {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    // Implementation
  };
}
```

## Advanced JSDoc Features

```typescript
/**
 * Calculates the optimal route between multiple waypoints
 * @function calculateRoute
 * @param waypoints - Array of geographic coordinates
 * @param options - Routing options and constraints
 * @returns Promise resolving to optimized route
 *
 * @template T - Waypoint type extending {@link GeoCoordinate}
 * @template O - Options type extending {@link RouteOptions}
 *
 * @example
 * ```typescript
 * const waypoints: GeoCoordinate[] = [
 *   { lat: 40.7128, lng: -74.0060, name: "New York" },
 *   { lat: 34.0522, lng: -118.2437, name: "Los Angeles" },
 *   { lat: 41.8781, lng: -87.6298, name: "Chicago" }
 * ];
 *
 * const route = await calculateRoute(waypoints, {
 *   optimize: true,
 *   avoidTolls: true,
 *   vehicleType: VehicleType.CAR,
 *   departureTime: new Date()
 * });
 *
 * console.log(`Total distance: ${route.totalDistance} km`);
 * console.log(`Estimated time: ${route.estimatedTime} hours`);
 * console.log(`Waypoints order: ${route.optimizedOrder}`);
 * ```
 *
 * @complexity
 * Time complexity: O(n² × 2ⁿ) where n is the number of waypoints
 * Space complexity: O(n × 2ⁿ) for the dynamic programming table
 *
 * @performance
 * - Optimized for n ≤ 20 waypoints
 * - Uses Web Workers for calculations > 100ms
 * - Implements early termination for time constraints
 * - Caches results for identical requests
 *
 * @accuracy
 * Distance calculations use Haversine formula with ±0.5% accuracy
 * Time estimates based on historical traffic data with 85% confidence
 * Elevation data from SRTM with 30m resolution
 *
 * @limitations
 * - Maximum 50 waypoints per request
 * - Routing limited to supported regions
 * - No real-time traffic integration in free tier
 * - Elevation gain calculations exclude tunnels/bridges
 *
 * @since 2.0.0
 * @author Jane Developer <jane@example.com>
 * @copyright 2024 MyCompany
 * @license MIT
 *
 * @throws {RouteCalculationError} If no valid route exists
 * @throws {MaxWaypointsError} If waypoints.length > 50
 * @throws {RegionNotSupportedError} For unsupported geographic regions
 *
 * @todo Implement real-time traffic integration
 * @todo Add support for electric vehicle routing
 * @todo Integrate weather conditions
 *
 * @see {@link https://developers.google.com/maps/documentation/directions Directions API}
 * @see {@link https://en.wikipedia.org/wiki/Haversine_formula Haversine Formula}
 * @see {@link RouteOptimizer} for optimization algorithm details
 */
export async function calculateRoute<T extends GeoCoordinate, O extends RouteOptions>(
  waypoints: T[],
  options?: O
): Promise<RouteResult<T>> {
  // Implementation
}
```

## Package Documentation

```typescript
/**
 * @packageDocumentation
 * # Data Validation Library
 *
 * A comprehensive, type-safe validation library for TypeScript with zero dependencies.
 * Provides declarative validation rules, custom validators, and detailed error messages.
 *
 * ## Features
 * - 🔒 **Type-safe**: Full TypeScript support with compile-time validation
 * - 🚀 **Fast**: Optimized validation with minimal runtime overhead
 * - 🎯 **Declarative**: Define rules using decorators or schema objects
 * - 🔧 **Extensible**: Create custom validators for any use case
 * - 📱 **Framework agnostic**: Works with any TypeScript project
 * - 🌍 **i18n ready**: Built-in internationalization support
 *
 * ## Quick Start
 * ```typescript
 * import { validate, IsEmail, IsNotEmpty, MinLength } from '@myorg/validation';
 *
 * class CreateUserDto {
 *   @IsEmail()
 *   email: string;
 *
 *   @IsNotEmpty()
 *   @MinLength(8)
 *   password: string;
 * }
 *
 * const errors = await validate(createUserDto);
 * if (errors.length > 0) {
 *   console.log('Validation failed:', errors);
 * }
 * ```
 *
 * ## Core Concepts
 *
 * ### Validators
 * Validators are functions that check if a value meets specific criteria:
 * ```typescript
 * const validator = IsEmail();
 * const result = validator('test@example.com'); // true
 * ```
 *
 * ### Validation Rules
 * Rules combine multiple validators with logical operators:
 * ```typescript
 * const rule = And(IsString(), MinLength(5), MaxLength(50));
 * ```
 *
 * ### Validation Schemas
 * Schemas define validation rules for complex objects:
 * ```typescript
 * const schema = Schema({
 *   name: IsString(),
 *   age: And(IsNumber(), Min(0), Max(120))
 * });
 * ```
 *
 * ## Advanced Usage
 *
 * ### Custom Validators
 * ```typescript
 * function IsStrongPassword(): Validator {
 *   return (value: string) => {
 *     return /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/.test(value);
 *   };
 * }
 * ```
 *
 * ### Conditional Validation
 * ```typescript
 * class Order {
 *   @IsNotEmpty()
 *   type: 'personal' | 'business';
 *
 *   @When(obj => obj.type === 'business', IsNotEmpty())
 *   companyName?: string;
 * }
 * ```
 *
 * ### Async Validation
 * ```typescript
 * async function IsUniqueEmail(): AsyncValidator {
 *   return async (value: string) => {
 *     const exists = await userRepository.existsByEmail(value);
 *     return !exists;
 *   };
 * }
 * ```
 *
 * ## Framework Integration
 *
 * ### NestJS
 * ```typescript
 * @Controller('users')
 * export class UserController {
 *   @Post()
 *   async create(@Body() @Validate() createUserDto: CreateUserDto) {
 *     // DTO is automatically validated
 *   }
 * }
 * ```
 *
 * ### Express.js
 * ```typescript
 * app.post('/users', validateBody(CreateUserDto), (req, res) => {
 *   // req.body is validated
 * });
 * ```
 *
 * ### React Hook Form
 * ```typescript
 * const { register, handleSubmit, formState: { errors } } = useForm({
 *   resolver: validationResolver(CreateUserDto)
 * });
 * ```
 *
 * ## Performance
 * - Validation runs in ~0.1ms per field on average
 * - Zero allocations for simple validations
 * - Lazy evaluation stops on first error
 * - Optimized for V8's hidden classes
 *
 * ## Browser Support
 * - Chrome 60+
 * - Firefox 55+
 * - Safari 11+
 * - Edge 79+
 *
 * ## License
 * MIT © [MyCompany](https://mycompany.com)
 *
 * ## Contributing
 * See [CONTRIBUTING.md](https://github.com/myorg/validation/blob/main/CONTRIBUTING.md)
 *
 * ## Changelog
 * See [CHANGELOG.md](https://github.com/myorg/validation/blob/main/CHANGELOG.md)
 */
```

> Keep examples compiling against supported TypeScript versions, and update them when public APIs change.
